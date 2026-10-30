// Project save/open and STL / 3MF export.

export function download(name, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- browser storage for the auto-save (holds far more than localStorage) ----------

let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('printcad', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function storeGet(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const q = d.transaction('kv').objectStore('kv').get(key);
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
}

export async function storeSet(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const TYPES = { '.stl': ['STL mesh', 'model/stl'], '.3mf': ['3MF model', 'model/3mf'] };

// Ask for a file name, then save. Chrome and Edge show a real Save As window. It has to
// open straight after the click, so `makeData` runs once a name is chosen. Other browsers
// ask for a name and save to Downloads. Returns the file name, or null if cancelled.
export async function saveAs(suggested, ext, makeData) {
  const [description, mime] = TYPES[ext];
  if (window.showSaveFilePicker) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: suggested + ext, types: [{ description, accept: { [mime]: [ext] } }] });
    } catch (e) {
      if (e.name === 'AbortError') return null;
      throw e;
    }
    const data = await makeData();
    const w = await handle.createWritable();
    await w.write(data);
    await w.close();
    return handle.name;
  }
  let name = prompt('Save as', suggested);
  if (!name?.trim()) return null;
  name = name.trim();
  if (!name.toLowerCase().endsWith(ext)) name += ext;
  download(name, await makeData(), mime);
  return name;
}

export function safeName(name) {
  return (name || 'model').replace(/[^\w\- ]+/g, '_').trim() || 'model';
}

export function openFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

// ---------- STL (binary) ----------

export function toSTL(bodies) {
  const triCount = bodies.reduce((n, b) => n + b.triangles.length / 3, 0);
  const buf = new ArrayBuffer(84 + triCount * 50);
  const dv = new DataView(buf);
  const header = 'Exported from NewfieCad';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, triCount, true);
  let o = 84;
  for (const b of bodies) {
    const v = b.vertices, t = b.triangles;
    for (let i = 0; i < t.length; i += 3) {
      const p = [t[i], t[i + 1], t[i + 2]].map((k) => [v[k * 3], v[k * 3 + 1], v[k * 3 + 2]]);
      const u = p[1].map((x, k) => x - p[0][k]), w = p[2].map((x, k) => x - p[0][k]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const l = Math.hypot(...n) || 1;
      for (const x of n) { dv.setFloat32(o, x / l, true); o += 4; }
      for (const q of p) for (const x of q) { dv.setFloat32(o, x, true); o += 4; }
      dv.setUint16(o, 0, true); o += 2;
    }
  }
  return buf;
}

// ---------- 3MF (a zip with an XML mesh) ----------

// Merge duplicate vertices so each body is one connected, watertight mesh.
function weld(b) {
  const map = new Map(), verts = [], tris = [];
  const v = b.vertices;
  const idx = (k) => {
    const key = `${Math.round(v[k * 3] * 1e4)},${Math.round(v[k * 3 + 1] * 1e4)},${Math.round(v[k * 3 + 2] * 1e4)}`;
    let i = map.get(key);
    if (i === undefined) { i = verts.length / 3; map.set(key, i); verts.push(v[k * 3], v[k * 3 + 1], v[k * 3 + 2]); }
    return i;
  };
  const t = b.triangles;
  for (let k = 0; k < t.length; k += 3) {
    const a = idx(t[k]), c = idx(t[k + 1]), d = idx(t[k + 2]);
    if (a !== c && c !== d && a !== d) tris.push(a, c, d);
  }
  return { name: b.name, vertices: verts, triangles: tris };
}

const xmlEscape = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function modelXML(bodies) {
  bodies = bodies.map(weld);
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n<resources>\n');
  bodies.forEach((b, i) => {
    parts.push(`<object id="${i + 1}" type="model" name="${xmlEscape(b.name)}"><mesh><vertices>\n`);
    const v = b.vertices;
    for (let k = 0; k < v.length; k += 3) parts.push(`<vertex x="${+v[k].toFixed(5)}" y="${+v[k + 1].toFixed(5)}" z="${+v[k + 2].toFixed(5)}"/>\n`);
    parts.push('</vertices><triangles>\n');
    const t = b.triangles;
    for (let k = 0; k < t.length; k += 3) parts.push(`<triangle v1="${t[k]}" v2="${t[k + 1]}" v3="${t[k + 2]}"/>\n`);
    parts.push('</triangles></mesh></object>\n');
  });
  parts.push('</resources>\n<build>\n');
  bodies.forEach((_, i) => parts.push(`<item objectid="${i + 1}"/>\n`));
  parts.push('</build>\n</model>\n');
  return parts.join('');
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Minimal zip writer (stored, no compression).
function zip(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    chunks.push(local.buffer, nameBytes, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true);
    central.push(cen.buffer, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end.buffer], { type: 'model/3mf' });
}

export function to3MF(bodies) {
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'],
    ['3D/3dmodel.model', modelXML(bodies)],
  ]);
}
