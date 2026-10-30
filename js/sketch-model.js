// Sketch data model: shared points, curves that refer to them, and constraints.
//
//   points:      [{ id, x, y }]
//   curves:      [{ id, t: 'line', p1, p2 } | { id, t: 'circle', c, r } | { id, t: 'arc', c, s, e }]
//                (arcs run counter-clockwise from s to e; any curve can have construction: true)
//   constraints: [{ id, type, refs: [ids], value? }]
//   entities:    the old flat list ({ t: 'line', a, b } ...), rebuilt from the curves for
//                profiles and the kernel. Construction curves are left out.

import { circleFrom3, rectCorners } from './profiles.js';

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const len = (a) => Math.hypot(a[0], a[1]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const TAU = 2 * Math.PI;
const normAngle = (t) => ((t % TAU) + TAU) % TAU;

// Constraints: how each one is shown, and what it needs selected.
export const CONSTRAINTS = {
  coincident: { label: 'Coincident', icon: '●', needs: 'two points, or a point and a curve' },
  horizontal: { label: 'Horizontal', icon: 'H', needs: 'lines, or two points' },
  vertical: { label: 'Vertical', icon: 'V', needs: 'lines, or two points' },
  parallel: { label: 'Parallel', icon: '∥', needs: 'two or more lines' },
  perpendicular: { label: 'Perpendicular', icon: '⊥', needs: 'two lines' },
  tangent: { label: 'Tangent', icon: 'T', needs: 'a circle or arc and another curve' },
  equal: { label: 'Equal', icon: '=', needs: 'two or more lines, or two or more circles/arcs' },
  concentric: { label: 'Concentric', icon: '◎', needs: 'two circles or arcs' },
  midpoint: { label: 'Midpoint', icon: 'M', needs: 'a point and a line' },
  fix: { label: 'Fix', icon: '🔒', needs: 'points or curves' },
  onCurve: { label: 'On curve', icon: '●' },
};

// Dimensions: value is in mm, or degrees for angles.
export const DIMENSIONS = new Set(['distance', 'length', 'pointLine', 'diameter', 'radius', 'angle']);

export function emptySketch(plane, offset) {
  return { plane, offset, points: [], curves: [], constraints: [], next: 1, entities: [] };
}

export const newId = (sk, prefix) => `${prefix}${sk.next++}`;

export function addPoint(sk, [x, y]) {
  const p = { id: newId(sk, 'p'), x, y };
  sk.points.push(p);
  return p.id;
}

export const pointById = (sk, id) => sk.points.find((p) => p.id === id);
export const curveById = (sk, id) => sk.curves.find((c) => c.id === id);
export const xy = (sk, id) => { const p = pointById(sk, id); return [p.x, p.y]; };

// Radius and angles of an arc, from its centre, start and end points.
export function arcGeom(sk, c) {
  const C = xy(sk, c.c), S = xy(sk, c.s), E = xy(sk, c.e);
  const a0 = Math.atan2(S[1] - C[1], S[0] - C[0]);
  let a1 = Math.atan2(E[1] - C[1], E[0] - C[0]);
  if (a1 <= a0) a1 += TAU;
  return { C, S, E, r: len(sub(S, C)), a0, a1 };
}

// Turn an old flat sketch (entities only) into points, curves and constraints.
// Ends that touch become one shared point; rectangles get their horizontal/vertical constraints.
export function migrate(params) {
  if (params.points) return params;
  const sk = emptySketch(params.plane, params.offset);
  if (params.frame) sk.frame = params.frame;
  const at = (q) => {
    const hit = sk.points.find((p) => Math.hypot(p.x - q[0], p.y - q[1]) < 1e-6);
    return hit ? hit.id : addPoint(sk, q);
  };
  const line = (a, b) => { const id = newId(sk, 'c'); sk.curves.push({ id, t: 'line', p1: at(a), p2: at(b) }); return id; };
  for (const e of params.entities || []) {
    if (e.t === 'line') line(e.a, e.b);
    else if (e.t === 'rect') {
      const k = rectCorners(e);
      const ids = k.map((q, i) => line(q, k[(i + 1) % 4]));
      ids.forEach((id, i) => addConstraint(sk, i % 2 ? 'vertical' : 'horizontal', [id]));
    } else if (e.t === 'circle') {
      sk.curves.push({ id: newId(sk, 'c'), t: 'circle', c: at(e.c), r: e.r });
    } else if (e.t === 'arc') addArc3(sk, at(e.a), at(e.b), e.m);
  }
  sk.entities = toEntities(sk);
  return sk;
}

// A three-point arc through start a, end b and point m (ids for a and b). Stored counter-clockwise.
export function addArc3(sk, aId, bId, m) {
  const A = xy(sk, aId), B = xy(sk, bId);
  const circ = circleFrom3(A, m, B);
  if (!circ) return null;
  const c = addPoint(sk, circ.c);
  // If m isn't on the counter-clockwise way from a to b, the arc runs from b to a.
  const ang = (q) => normAngle(Math.atan2(q[1] - circ.c[1], q[0] - circ.c[0]) - Math.atan2(A[1] - circ.c[1], A[0] - circ.c[0]));
  const ccw = ang(m) < ang(B);
  const id = newId(sk, 'c');
  sk.curves.push({ id, t: 'arc', c, s: ccw ? aId : bId, e: ccw ? bId : aId });
  return id;
}

export function addConstraint(sk, type, refs, value) {
  const k = { id: newId(sk, 'k'), type, refs };
  if (value !== undefined) k.value = value;
  sk.constraints.push(k);
  return k;
}

// The flat entity list used by profiles and the kernel (and, with construction, for display).
export function toEntities(sk, withConstruction = false) {
  const out = [];
  for (const c of sk.curves) {
    if (c.construction && !withConstruction) continue;
    if (c.t === 'line') out.push({ t: 'line', a: xy(sk, c.p1), b: xy(sk, c.p2), id: c.id });
    else if (c.t === 'circle') out.push({ t: 'circle', c: xy(sk, c.c), r: c.r, id: c.id });
    else if (c.t === 'arc') {
      const g = arcGeom(sk, c);
      const mid = (g.a0 + g.a1) / 2;
      out.push({ t: 'arc', a: g.S, b: g.E, m: [g.C[0] + g.r * Math.cos(mid), g.C[1] + g.r * Math.sin(mid)], id: c.id });
    }
  }
  return out;
}

// Points a curve is built from.
export function curvePoints(c) {
  return c.t === 'line' ? [c.p1, c.p2] : c.t === 'circle' ? [c.c] : [c.c, c.s, c.e];
}

// Remove point b by merging it into point a (used for Coincident and Concentric).
export function mergePoints(sk, a, b) {
  if (a === b) return;
  const swap = (id) => (id === b ? a : id);
  for (const c of sk.curves) for (const k of ['p1', 'p2', 'c', 's', 'e']) if (c[k]) c[k] = swap(c[k]);
  for (const k of sk.constraints) k.refs = k.refs.map(swap);
  sk.points = sk.points.filter((p) => p.id !== b);
  // A line whose two ends merged is gone.
  sk.curves = sk.curves.filter((c) => !(c.t === 'line' && c.p1 === c.p2));
  pruneConstraints(sk);
}

// Drop constraints that refer to missing items, and points no curve uses.
export function pruneConstraints(sk) {
  const used = new Set(sk.curves.flatMap(curvePoints));
  sk.points = sk.points.filter((p) => used.has(p.id));
  const ids = new Set([...sk.points.map((p) => p.id), ...sk.curves.map((c) => c.id)]);
  sk.constraints = sk.constraints.filter((k) => k.refs.every((r) => ids.has(r)));
}

export function deleteItems(sk, ids) {
  const set = new Set(ids);
  sk.constraints = sk.constraints.filter((k) => !set.has(k.id));
  sk.curves = sk.curves.filter((c) => !set.has(c.id) && !curvePoints(c).some((p) => set.has(p)));
  pruneConstraints(sk);
}

// ---------- hit testing in sketch coordinates ----------

function distToSeg(p, a, b) {
  const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (dot(ab, ab) || 1)));
  return len(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t]));
}

export function distToCurve(sk, c, p) {
  if (c.t === 'line') return distToSeg(p, xy(sk, c.p1), xy(sk, c.p2));
  if (c.t === 'circle') return Math.abs(len(sub(p, xy(sk, c.c))) - c.r);
  const g = arcGeom(sk, c);
  let t = Math.atan2(p[1] - g.C[1], p[0] - g.C[0]);
  while (t < g.a0) t += TAU;
  if (t <= g.a1) return Math.abs(len(sub(p, g.C)) - g.r);
  return Math.min(len(sub(p, g.S)), len(sub(p, g.E)));
}

// Nearest point within tol, else nearest curve within tol, else null.
export function hitTest(sk, p, tol, { points = true, curves = true } = {}) {
  if (points) {
    let best = null, bd = tol;
    for (const q of sk.points) {
      const d = Math.hypot(q.x - p[0], q.y - p[1]);
      if (d < bd) { bd = d; best = q.id; }
    }
    if (best) return { kind: 'point', id: best };
  }
  if (curves) {
    let best = null, bd = tol;
    for (const c of sk.curves) {
      const d = distToCurve(sk, c, p);
      if (d < bd) { bd = d; best = c.id; }
    }
    if (best) return { kind: 'curve', id: best };
  }
  return null;
}

// Signed angle (degrees) from line a's direction to line b's direction.
export function lineAngle(sk, a, b) {
  const da = sub(xy(sk, a.p2), xy(sk, a.p1)), db = sub(xy(sk, b.p2), xy(sk, b.p1));
  return (Math.atan2(da[0] * db[1] - da[1] * db[0], dot(da, db)) * 180) / Math.PI;
}

// Current measured value of a dimension.
export function measure(sk, k) {
  const [a, b] = k.refs;
  switch (k.type) {
    case 'distance': return len(sub(xy(sk, a), xy(sk, b)));
    case 'length': { const c = curveById(sk, a); return len(sub(xy(sk, c.p2), xy(sk, c.p1))); }
    case 'pointLine': {
      const c = curveById(sk, b), P = xy(sk, a), A = xy(sk, c.p1), d = sub(xy(sk, c.p2), A);
      return Math.abs(d[0] * (P[1] - A[1]) - d[1] * (P[0] - A[0])) / (len(d) || 1);
    }
    case 'diameter': return 2 * curveById(sk, a).r;
    case 'radius': return arcGeom(sk, curveById(sk, a)).r;
    case 'angle': return Math.abs(lineAngle(sk, curveById(sk, a), curveById(sk, b)));
  }
  return 0;
}

// Where a constraint's icon or a dimension's value sits: [anchor point, direction to push it out].
export function labelAnchor(sk, k, refIndex = 0) {
  const id = k.refs[refIndex];
  const p = pointById(sk, id);
  if (p) return [[p.x, p.y], [0.7, 0.7]];
  const c = curveById(sk, id);
  if (!c) return null;
  if (c.t === 'line') {
    const A = xy(sk, c.p1), B = xy(sk, c.p2), d = sub(B, A), l = len(d) || 1;
    return [[(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], [-d[1] / l, d[0] / l]];
  }
  if (c.t === 'circle') { const C = xy(sk, c.c); return [[C[0] + c.r * 0.7071, C[1] + c.r * 0.7071], [0.7071, 0.7071]]; }
  const g = arcGeom(sk, c), m = (g.a0 + g.a1) / 2;
  return [[g.C[0] + g.r * Math.cos(m), g.C[1] + g.r * Math.sin(m)], [Math.cos(m), Math.sin(m)]];
}
