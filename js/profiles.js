// Pure 2D sketch geometry, shared by the UI and the kernel worker.
// Turns sketch entities into closed loops and fillable regions (outer loop + holes).

import { toShape, intersect, paramOf, pointAt, endsOf, near, norm, TAU } from './geom2d.js';

const EPS = 1e-6;

// Sketch planes in a Z-up world. y direction = normal x xDir.
export const PLANES = {
  XY: { xDir: [1, 0, 0], yDir: [0, 1, 0], normal: [0, 0, 1] },
  XZ: { xDir: [1, 0, 0], yDir: [0, 0, 1], normal: [0, -1, 0] },
  YZ: { xDir: [0, 1, 0], yDir: [0, 0, 1], normal: [1, 0, 0] },
};

export function planeFrame(plane, offset = 0) {
  const p = PLANES[plane] || PLANES.XY;
  return { ...p, origin: p.normal.map((v) => v * offset) };
}

// Where a sketch lies: its own frame (sketches on slanted faces), or an origin plane and offset.
export function sketchFrame(p) {
  return p.frame || planeFrame(p.plane, p.offset);
}

// A sketch frame on any flat face: the world origin projected onto the face, x along
// world X (or Y) as seen on the face, y = normal x x.
export function faceFrame(point, normal) {
  const n = normal;
  const d = n[0] * point[0] + n[1] * point[1] + n[2] * point[2];
  const ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const k = ref[0] * n[0] + ref[1] * n[1] + ref[2] * n[2];
  let x = ref.map((v, i) => v - k * n[i]);
  const l = Math.hypot(...x);
  x = x.map((v) => v / l);
  const y = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]];
  const r = (v) => Math.round(v * 1e6) / 1e6;
  return { origin: n.map((v) => r(v * d)), xDir: x.map(r), yDir: y.map(r), normal: n.map(r) };
}

// Local sketch coordinates -> world point.
export function toWorld(frame, u, v) {
  return [0, 1, 2].map((i) => frame.origin[i] + frame.xDir[i] * u + frame.yDir[i] * v);
}

export const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const key = (p) => `${Math.round(p[0] / EPS)},${Math.round(p[1] / EPS)}`;

// Circle through three points, or null if they are collinear.
export function circleFrom3(a, m, b) {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return null;
  const sa = a[0] ** 2 + a[1] ** 2, sm = m[0] ** 2 + m[1] ** 2, sb = b[0] ** 2 + b[1] ** 2;
  const cx = (sa * (m[1] - b[1]) + sm * (b[1] - a[1]) + sb * (a[1] - m[1])) / d;
  const cy = (sa * (b[0] - m[0]) + sm * (a[0] - b[0]) + sb * (m[0] - a[0])) / d;
  return { c: [cx, cy], r: Math.hypot(a[0] - cx, a[1] - cy) };
}

// Sample a three-point arc from a through m to b.
export function sampleArc(a, m, b, n = 32) {
  const circ = circleFrom3(a, m, b);
  if (!circ) return [a, b];
  const { c, r } = circ;
  const ang = (p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const a0 = ang(a);
  const norm = (t) => ((t - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  let sweep = norm(ang(b));
  // If the mid point is not inside the CCW sweep, go clockwise instead.
  if (norm(ang(m)) > sweep) sweep -= 2 * Math.PI;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = a0 + (sweep * i) / n;
    pts.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  return pts;
}

export function sampleCircle(c, r, n = 64) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * i) / n;
    pts.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  return pts;
}

export function rectCorners(e) {
  const [x0, y0] = e.a, [x1, y1] = e.b;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

// Polyline for drawing any entity.
export function entityPolyline(e) {
  switch (e.t) {
    case 'line': return [e.a, e.b];
    case 'rect': { const c = rectCorners(e); return [...c, c[0]]; }
    case 'circle': return sampleCircle(e.c, e.r);
    case 'arc': return sampleArc(e.a, e.m, e.b);
  }
  return [];
}

// The chain of lines and arcs joined end to end through entity `index` (a sweep path).
// It stops where curves branch. Returns { items: [{ e, rev }] in order, closed } or null;
// `rev` means the curve runs backwards along the chain. A circle or rectangle is a chain on its own.
export function curveChain(entities, index) {
  const start = entities?.[index];
  if (!start) return null;
  const open = (e) => e.t === 'line' || e.t === 'arc';
  if (!open(start)) return { items: [{ e: start, rev: false }], closed: true };
  const at = (p, q) => dist2(p, q) < 1e-4;
  const used = new Set([index]);
  const items = [{ e: start, rev: false }];
  const grow = (forward) => {
    for (;;) {
      const tip = forward ? items.at(-1) : items[0];
      const p = forward === !tip.rev ? tip.e.b : tip.e.a;
      const next = [];
      entities.forEach((e, i) => { if (!used.has(i) && open(e) && (at(e.a, p) || at(e.b, p))) next.push(i); });
      if (next.length !== 1) return;
      const e = entities[next[0]];
      used.add(next[0]);
      if (forward) items.push({ e, rev: at(e.b, p) });
      else items.unshift({ e, rev: at(e.a, p) });
    }
  };
  grow(true);
  grow(false);
  const first = items[0], last = items.at(-1);
  return { items, closed: items.length > 1 && at(first.rev ? first.e.b : first.e.a, last.rev ? last.e.a : last.e.b) };
}

// Key points of an entity, used for snapping.
export function entityPoints(e) {
  switch (e.t) {
    case 'line': return [e.a, e.b];
    case 'rect': return rectCorners(e);
    case 'circle': return [e.c];
    case 'arc': return [e.a, e.b];
  }
  return [];
}

function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length - 1; i++) s += poly[i][0] * poly[i + 1][1] - poly[i + 1][0] * poly[i][1];
  return s / 2;
}

export function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Build closed loops from the entities. Rectangles and circles are loops on their own;
// lines and arcs are chained end to end.
function buildLoops(entities) {
  const loops = [];
  const chainable = [];
  for (const e of entities) {
    if (e.t === 'rect') {
      const c = rectCorners(e);
      if (dist2(c[0], c[2]) < EPS) continue;
      loops.push({ segs: c.map((p, i) => ({ t: 'line', a: p, b: c[(i + 1) % 4] })) });
    } else if (e.t === 'circle') {
      if (e.r > EPS) loops.push({ segs: [{ t: 'circle', c: e.c, r: e.r }] });
    } else if ((e.t === 'line' || e.t === 'arc') && dist2(e.a, e.b) > EPS) {
      chainable.push(e);
    }
  }

  const byVertex = new Map();
  const add = (p, i) => {
    const k = key(p);
    if (!byVertex.has(k)) byVertex.set(k, []);
    byVertex.get(k).push(i);
  };
  chainable.forEach((e, i) => { add(e.a, i); add(e.b, i); });

  const used = new Set();
  for (let s = 0; s < chainable.length; s++) {
    if (used.has(s)) continue;
    const first = chainable[s];
    const segs = [{ ...first }];
    const chain = [s];
    const startKey = key(first.a);
    let cur = first.b;
    let closed = false;
    for (let guard = 0; guard < chainable.length; guard++) {
      const k = key(cur);
      if (k === startKey) { closed = true; break; }
      const next = (byVertex.get(k) || []).filter((i) => !chain.includes(i));
      if ((byVertex.get(k) || []).length !== 2 || next.length !== 1) break;
      const e = chainable[next[0]];
      const forward = key(e.a) === k;
      segs.push(forward ? { ...e } : { ...e, a: e.b, b: e.a });
      chain.push(next[0]);
      cur = forward ? e.b : e.a;
    }
    if (closed && (segs.length > 1 || first.t === 'arc')) {
      chain.forEach((i) => used.add(i));
      loops.push({ segs });
    }
  }

  for (const loop of loops) {
    loop.poly = loopPolyline(loop.segs);
    loop.area = Math.abs(polyArea(loop.poly));
  }
  return loops.filter((l) => l.area > EPS);
}

export function loopPolyline(segs) {
  if (segs[0].t === 'circle') return sampleCircle(segs[0].c, segs[0].r);
  const pts = [];
  for (const s of segs) {
    const p = s.t === 'arc' ? sampleArc(s.a, s.m, s.b, 24) : [s.a, s.b];
    pts.push(...(pts.length ? p.slice(1) : p));
  }
  return pts;
}

// Regions: even-depth loops are solid, their direct odd-depth children are holes.
// When curves cross each other, every enclosed area becomes its own region instead.
export function buildProfiles(entities) {
  const shapes = shapesOf(entities || []);
  if (hasCrossings(shapes)) return arrangeProfiles(shapes);
  const loops = buildLoops(entities || []);
  const depth = loops.map((l, i) =>
    loops.filter((o, j) => j !== i && o.area > l.area && pointInPoly(l.poly[0], o.poly)).length);
  const regions = [];
  loops.forEach((l, i) => {
    if (depth[i] % 2) return;
    const holes = loops
      .map((h, j) => j)
      .filter((j) => depth[j] === depth[i] + 1 && loops[i].area > loops[j].area && pointInPoly(loops[j].poly[0], l.poly));
    regions.push({ outer: i, holes });
  });
  return { loops, regions };
}

// ---------- crossing shapes ----------

function shapesOf(entities) {
  const out = [];
  for (const e of entities) {
    if (e.t === 'rect') {
      const c = rectCorners(e);
      if (dist2(c[0], c[2]) > EPS) c.forEach((p, i) => out.push({ t: 'line', a: p, b: c[(i + 1) % 4] }));
    } else if (e.t === 'circle') { if (e.r > EPS) out.push({ t: 'circle', c: e.c, r: e.r }); }
    else if ((e.t === 'line' || e.t === 'arc') && dist2(e.a, e.b) > EPS) out.push(toShape(e));
  }
  return out;
}

// Do any two curves meet anywhere other than at ends they share?
function hasCrossings(shapes) {
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      for (const p of intersect(shapes[i], shapes[j])) {
        const sharedEnd = endsOf(shapes[i]).some((q) => near(q, p)) && endsOf(shapes[j]).some((q) => near(q, p));
        if (!sharedEnd) return true;
      }
    }
  }
  return false;
}

// Split every curve where others cross it, then walk the network: each area enclosed
// counter-clockwise is a region. Separate pieces lying inside a region become its holes.
function arrangeProfiles(shapes) {
  const uniq = (ts) => ts.sort((a, b) => a - b).filter((t, i, arr) => i === 0 || t - arr[i - 1] > 1e-9);
  const pieces = [], loose = [];
  shapes.forEach((s, i) => {
    let ts = [];
    shapes.forEach((o, j) => { if (j !== i) for (const p of intersect(s, o)) ts.push(paramOf(s, p)); });
    if (s.t === 'line') {
      ts = uniq([0, 1, ...ts.filter((t) => t > 0 && t < 1)]);
      for (let k = 0; k + 1 < ts.length; k++) pieces.push({ t: 'line', a: pointAt(s, ts[k]), b: pointAt(s, ts[k + 1]) });
    } else if (s.t === 'arc') {
      ts = uniq([s.a0, s.a1, ...ts.filter((t) => t > s.a0 && t < s.a1)]);
      for (let k = 0; k + 1 < ts.length; k++) pieces.push({ t: 'arc', c: s.c, r: s.r, t0: ts[k], t1: ts[k + 1] });
    } else {
      ts = uniq(ts.map(norm));
      if (ts.length < 2) { loose.push(s); return; }
      ts.forEach((t, k) => pieces.push({ t: 'arc', c: s.c, r: s.r, t0: t, t1: k + 1 < ts.length ? ts[k + 1] : ts[0] + TAU }));
    }
  });
  for (const p of pieces) if (p.t === 'arc') { p.a = pointAt(p, p.t0); p.b = pointAt(p, p.t1); }

  // Shared vertices, and pieces that don't end in a dead end.
  const vid = new Map(), vkey = (p) => key(p);
  const vert = (p) => { const k = vkey(p); if (!vid.has(k)) vid.set(k, vid.size); return vid.get(k); };
  let live = pieces.map((p) => ({ ...p, u: vert(p.a), v: vert(p.b) })).filter((p) => p.u !== p.v);
  for (let changed = true; changed;) {
    const deg = new Map();
    live.forEach((p) => { deg.set(p.u, (deg.get(p.u) || 0) + 1); deg.set(p.v, (deg.get(p.v) || 0) + 1); });
    const next = live.filter((p) => deg.get(p.u) > 1 && deg.get(p.v) > 1);
    changed = next.length !== live.length;
    live = next;
  }

  // Half-edges, sorted counter-clockwise around each vertex by the direction they leave in.
  const out = new Map();
  const half = [];
  live.forEach((p, k) => {
    const fwd = p.t === 'line' ? Math.atan2(p.b[1] - p.a[1], p.b[0] - p.a[0]) : p.t0 + Math.PI / 2;
    const back = p.t === 'line' ? Math.atan2(p.a[1] - p.b[1], p.a[0] - p.b[0]) : p.t1 - Math.PI / 2;
    half.push({ k, from: p.u, to: p.v, fwd: true, ang: norm(fwd) }, { k, from: p.v, to: p.u, fwd: false, ang: norm(back) });
  });
  half.forEach((h, i) => { h.twin = i ^ 1; if (!out.has(h.from)) out.set(h.from, []); out.get(h.from).push(i); });
  for (const list of out.values()) list.sort((a, b) => half[a].ang - half[b].ang);

  // Walk faces keeping the face on the left: at each vertex take the next edge clockwise.
  const seen = new Set(), cycles = [];
  half.forEach((_, start) => {
    if (seen.has(start)) return;
    const cyc = [];
    for (let h = start, guard = 0; !seen.has(h) && guard < half.length; guard++) {
      seen.add(h);
      cyc.push(h);
      const list = out.get(half[h].to), i = list.indexOf(half[h].twin);
      h = list[(i - 1 + list.length) % list.length];
    }
    cycles.push(cyc);
  });

  // Group into connected pieces so holes can be told from neighbouring faces.
  const parent = [...Array(vid.size).keys()];
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  live.forEach((p) => { parent[find(p.u)] = find(p.v); });

  const segOf = (h) => {
    const e = half[h], p = live[e.k];
    if (p.t === 'line') return e.fwd ? { t: 'line', a: p.a, b: p.b } : { t: 'line', a: p.b, b: p.a };
    const m = pointAt(p, (p.t0 + p.t1) / 2);
    return e.fwd ? { t: 'arc', a: p.a, b: p.b, m } : { t: 'arc', a: p.b, b: p.a, m };
  };
  const faces = [], bounds = [];
  for (const cyc of cycles) {
    const segs = cyc.map(segOf);
    const poly = loopPolyline(segs);
    const area = polyArea(poly);
    const item = { segs, poly, area: Math.abs(area), comp: find(half[cyc[0]].from) };
    if (area > EPS) faces.push(item); else if (area < -EPS) bounds.push(item);
  }
  // A circle that crosses nothing is both a region and, inside another region, a hole.
  loose.forEach((c, i) => {
    const item = { segs: [{ t: 'circle', c: c.c, r: c.r }], poly: sampleCircle(c.c, c.r), area: Math.PI * c.r * c.r, comp: `loose${i}` };
    faces.push(item);
    bounds.push(item);
  });

  const loops = [], regions = [];
  const loopIndex = new Map();
  const loopOf = (item) => { if (!loopIndex.has(item)) { loopIndex.set(item, loops.length); loops.push(item); } return loopIndex.get(item); };
  const holes = new Map(faces.map((f) => [f, []]));
  for (const b of bounds) {
    let best = null;
    for (const f of faces) {
      if (f.comp === b.comp || f.area <= b.area || !pointInPoly(b.poly[0], f.poly)) continue;
      if (!best || f.area < best.area) best = f;
    }
    if (best) holes.get(best).push(b);
  }
  for (const f of faces) regions.push({ outer: loopOf(f), holes: holes.get(f).map(loopOf) });
  return { loops, regions };
}
