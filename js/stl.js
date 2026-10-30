// STL reading and the compact mesh format stored in projects. Shared by the page,
// the simplify worker and the kernel worker.

// Read a binary or ASCII STL into a welded mesh: { positions: Float32Array, indices: Uint32Array }.
export function parseSTL(buffer) {
  const dv = new DataView(buffer);
  const n = buffer.byteLength >= 84 ? dv.getUint32(80, true) : 0;
  const binary = buffer.byteLength === 84 + n * 50 ||
    !new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(256, buffer.byteLength))).trimStart().startsWith('solid');
  const raw = [];
  if (binary) {
    let o = 84;
    for (let i = 0; i < n; i++) {
      o += 12;
      for (let k = 0; k < 9; k++) { raw.push(dv.getFloat32(o, true)); o += 4; }
      o += 2;
    }
  } else {
    const text = new TextDecoder().decode(buffer);
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    let m;
    while ((m = re.exec(text))) raw.push(+m[1], +m[2], +m[3]);
  }
  if (!raw.length || raw.length % 9) throw new Error('No triangles found in this file');
  return weld(raw);
}

// Merge vertices closer than 0.0001 mm and drop triangles that collapse.
function weld(raw) {
  const map = new Map(), pos = [], idx = [];
  const id = (k) => {
    const key = `${Math.round(raw[k] * 1e4)},${Math.round(raw[k + 1] * 1e4)},${Math.round(raw[k + 2] * 1e4)}`;
    let i = map.get(key);
    if (i === undefined) { i = pos.length / 3; map.set(key, i); pos.push(raw[k], raw[k + 1], raw[k + 2]); }
    return i;
  };
  for (let k = 0; k < raw.length; k += 9) {
    const a = id(k), b = id(k + 3), c = id(k + 6);
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

const toB64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function encodeMesh(m) {
  return { v: toB64(new Uint8Array(m.positions.buffer)), t: toB64(new Uint8Array(m.indices.buffer)) };
}

export function decodeMesh(e) {
  return { positions: new Float32Array(fromB64(e.v).buffer), indices: new Uint32Array(fromB64(e.t).buffer) };
}

// Binary STL bytes, with each vertex scaled per axis.
export function meshToSTL(m, scale = [1, 1, 1]) {
  const { positions: p, indices: t } = m;
  const n = t.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let i = 0; i < t.length; i += 3) {
    o += 12; // the reader works out normals itself
    for (let k = 0; k < 3; k++) {
      const v = t[i + k] * 3;
      for (let a = 0; a < 3; a++) { dv.setFloat32(o, p[v + a] * scale[a], true); o += 4; }
    }
    o += 2;
  }
  return new Uint8Array(buf);
}
