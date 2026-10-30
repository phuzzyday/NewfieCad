// Sketch editing tools that build or reshape geometry: polygon, slot, fillet, trim,
// offset and project. Each works on the sketch model in place and adds the constraints
// that keep the result behaving like one shape. Errors are thrown as readable messages.

import * as M from './sketch-model.js';
import * as G from './geom2d.js';

const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const unit = (a) => { const l = Math.hypot(a[0], a[1]) || 1; return [a[0] / l, a[1] / l]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];

export function shapeOf(sk, c) {
  if (c.t === 'line') return { t: 'line', a: M.xy(sk, c.p1), b: M.xy(sk, c.p2) };
  if (c.t === 'circle') return { t: 'circle', c: M.xy(sk, c.c), r: c.r };
  const g = M.arcGeom(sk, c);
  return { t: 'arc', c: g.C, r: g.r, a0: g.a0, a1: g.a1 };
}

const pushCurve = (sk, c) => { const id = M.newId(sk, 'c'); sk.curves.push({ id, ...c }); return id; };

// An existing point at p, or a new one.
function pointAt(sk, p) {
  const hit = sk.points.find((q) => Math.hypot(q.x - p[0], q.y - p[1]) < 1e-6);
  return hit ? hit.id : M.addPoint(sk, p);
}

// Arc from point s to point e around centre c, going the way that passes near `via`.
function arcVia(sk, c, s, e, via) {
  const C = M.xy(sk, c), ang = (p) => Math.atan2(p[1] - C[1], p[0] - C[0]);
  const a0 = ang(M.xy(sk, s));
  const ccw = G.norm(ang(via) - a0) < G.norm(ang(M.xy(sk, e)) - a0);
  return pushCurve(sk, { t: 'arc', c, s: ccw ? s : e, e: ccw ? e : s });
}

// Regular polygon: corners on a construction circle, all sides equal.
export function addPolygon(sk, centerId, corner, sides) {
  const n = Math.max(3, Math.min(64, Math.round(sides)));
  const C = M.xy(sk, centerId), r = Math.hypot(corner[0] - C[0], corner[1] - C[1]);
  if (r < 1e-6) throw new Error('Move away from the centre to size the polygon.');
  const a0 = Math.atan2(corner[1] - C[1], corner[0] - C[0]);
  const circle = pushCurve(sk, { t: 'circle', c: centerId, r, construction: true });
  const pts = [];
  for (let k = 0; k < n; k++) pts.push(M.addPoint(sk, add(C, mul([Math.cos(a0 + (k * G.TAU) / n), Math.sin(a0 + (k * G.TAU) / n)], r))));
  const lines = pts.map((p, k) => pushCurve(sk, { t: 'line', p1: p, p2: pts[(k + 1) % n] }));
  pts.forEach((p) => M.addConstraint(sk, 'onCurve', [p, circle]));
  lines.slice(1).forEach((l) => M.addConstraint(sk, 'equal', [lines[0], l]));
  return lines;
}

// Centre-to-centre slot: two half circles joined by tangent lines, ends of equal size.
export function addSlot(sk, c1, c2, width) {
  const C1 = M.xy(sk, c1), C2 = M.xy(sk, c2);
  const d = unit([C2[0] - C1[0], C2[1] - C1[1]]), n = [-d[1], d[0]], r = width / 2;
  if (!(r > 1e-6) || Math.hypot(C2[0] - C1[0], C2[1] - C1[1]) < 1e-6) throw new Error('Give the slot a length and a width.');
  const A1 = M.addPoint(sk, add(C1, mul(n, r))), B1 = M.addPoint(sk, add(C1, mul(n, -r)));
  const A2 = M.addPoint(sk, add(C2, mul(n, r))), B2 = M.addPoint(sk, add(C2, mul(n, -r)));
  const top = pushCurve(sk, { t: 'line', p1: A1, p2: A2 });
  const bottom = pushCurve(sk, { t: 'line', p1: B1, p2: B2 });
  const end2 = pushCurve(sk, { t: 'arc', c: c2, s: B2, e: A2 });
  const end1 = pushCurve(sk, { t: 'arc', c: c1, s: A1, e: B1 });
  pushCurve(sk, { t: 'line', p1: c1, p2: c2, construction: true });
  for (const l of [top, bottom]) for (const a of [end1, end2]) M.addConstraint(sk, 'tangent', [l, a]);
  M.addConstraint(sk, 'equal', [end1, end2]);
}

// Round the corner where two lines meet at point p.
export function filletCorner(sk, p, r) {
  const lines = sk.curves.filter((c) => c.t === 'line' && !c.construction && (c.p1 === p || c.p2 === p));
  if (lines.length !== 2) throw new Error('Click a corner where exactly two lines meet.');
  const P = M.xy(sk, p);
  const far = (l) => M.xy(sk, l.p1 === p ? l.p2 : l.p1);
  const [A, B] = lines.map(far);
  const u1 = unit([A[0] - P[0], A[1] - P[1]]), u2 = unit([B[0] - P[0], B[1] - P[1]]);
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  if (theta < 1e-3 || theta > Math.PI - 1e-3) throw new Error('Those lines are in line with each other.');
  const t = r / Math.tan(theta / 2);
  if (t >= Math.hypot(A[0] - P[0], A[1] - P[1]) || t >= Math.hypot(B[0] - P[0], B[1] - P[1])) throw new Error('That radius is too big for these lines.');
  const T1 = M.addPoint(sk, add(P, mul(u1, t))), T2 = M.addPoint(sk, add(P, mul(u2, t)));
  const C = M.addPoint(sk, add(P, mul(unit(add(u1, u2)), r / Math.sin(theta / 2))));
  for (const [l, q] of [[lines[0], T1], [lines[1], T2]]) { if (l.p1 === p) l.p1 = q; else l.p2 = q; }
  const arc = arcVia(sk, C, T1, T2, P);
  M.addConstraint(sk, 'tangent', [lines[0].id, arc]);
  M.addConstraint(sk, 'tangent', [lines[1].id, arc]);
  M.addConstraint(sk, 'radius', [arc], Math.round(r * 1000) / 1000);
  M.pruneConstraints(sk);
}

// ---------- trim ----------

// Cut points on curve c from every other curve: [{ t, p, by }].
function cutsOn(sk, c) {
  const s = shapeOf(sk, c), out = [];
  for (const o of sk.curves) {
    if (o.id === c.id) continue;
    for (const p of G.intersect(s, shapeOf(sk, o))) out.push({ t: G.paramOf(s, p), p, by: o.id });
  }
  return out;
}

// A point where a trimmed end now sits: an existing point there, or a new one kept on the cutting curve.
function cutPoint(sk, cut) {
  const hit = sk.points.find((q) => Math.hypot(q.x - cut.p[0], q.y - cut.p[1]) < 1e-6);
  if (hit) return hit.id;
  const id = M.addPoint(sk, cut.p);
  M.addConstraint(sk, 'onCurve', [id, cut.by]);
  return id;
}

// Remove the piece of curve `id` around `uv`, between the nearest crossings either side.
export function trimAt(sk, id, uv) {
  const c = M.curveById(sk, id);
  const s = shapeOf(sk, c);
  const tc = G.paramOf(s, uv);
  const cuts = cutsOn(sk, c);
  const dropLength = () => { sk.constraints = sk.constraints.filter((k) => !(k.type === 'length' && k.refs[0] === c.id)); };

  if (c.t === 'circle') {
    const inner = dedupe(cuts);
    if (inner.length < 2) { M.deleteItems(sk, [id]); return; }
    const sorted = inner.sort((a, b) => a.t - b.t);
    const hi = sorted.find((k) => k.t > tc) || sorted[0];
    const lo = [...sorted].reverse().find((k) => k.t < tc) || sorted[sorted.length - 1];
    // What stays is the arc from hi round to lo.
    const sId = cutPoint(sk, hi), eId = cutPoint(sk, lo);
    Object.assign(c, { t: 'arc', s: sId, e: eId });
    delete c.r;
    for (const k of sk.constraints) if (k.type === 'diameter' && k.refs[0] === id) { k.type = 'radius'; k.value /= 2; }
    return;
  }

  const [t0, t1] = c.t === 'line' ? [0, 1] : [s.a0, s.a1];
  const inner = dedupe(cuts.filter((k) => k.t > t0 + 1e-7 && k.t < t1 - 1e-7));
  const lo = inner.filter((k) => k.t < tc).sort((a, b) => b.t - a.t)[0];
  const hi = inner.filter((k) => k.t > tc).sort((a, b) => a.t - b.t)[0];
  const [startKey, endKey] = c.t === 'line' ? ['p1', 'p2'] : ['s', 'e'];
  if (!lo && !hi) { M.deleteItems(sk, [id]); return; }
  dropLength();
  if (!lo) { c[startKey] = cutPoint(sk, hi); }
  else if (!hi) { c[endKey] = cutPoint(sk, lo); }
  else {
    // Split in two: this curve keeps the start, a copy keeps the end.
    const end = c[endKey];
    c[endKey] = cutPoint(sk, lo);
    const copy = { ...c, [startKey]: cutPoint(sk, hi), [endKey]: end };
    delete copy.id;
    const nid = pushCurve(sk, copy);
    for (const k of [...sk.constraints]) {
      if ((k.type === 'horizontal' || k.type === 'vertical') && k.refs[0] === id && k.refs.length === 1) M.addConstraint(sk, k.type, [nid]);
    }
  }
  M.pruneConstraints(sk);
}

function dedupe(cuts) {
  const out = [];
  for (const k of cuts) if (!out.some((o) => G.near(o.p, k.p))) out.push(k);
  return out;
}

// ---------- offset ----------

// Order selected curves into a chain through their shared points: [{ c, from, to }].
function chainOf(sk, curves) {
  const ends = (c) => (c.t === 'line' ? [c.p1, c.p2] : [c.s, c.e]);
  const count = new Map();
  curves.forEach((c) => ends(c).forEach((p) => count.set(p, (count.get(p) || 0) + 1)));
  if ([...count.values()].some((n) => n > 2)) throw new Error('Offset works on one chain of connected curves.');
  const left = [...curves];
  let at = [...count.entries()].find(([, n]) => n === 1)?.[0] ?? ends(left[0])[0];
  const out = [];
  while (left.length) {
    const i = left.findIndex((c) => ends(c).includes(at));
    if (i < 0) throw new Error('The selected curves must join end to end.');
    const c = left.splice(i, 1)[0];
    const [a, b] = ends(c);
    const from = a === at ? a : b, to = a === at ? b : a;
    out.push({ c, from, to });
    at = to;
  }
  return { chain: out, closed: out[0].from === out[out.length - 1].to };
}

// Copies of the selected curves, `d` mm to the side (outward for a closed loop).
export function offsetCurves(sk, ids, d) {
  const curves = ids.map((id) => M.curveById(sk, id)).filter(Boolean);
  if (!curves.length) throw new Error('Select the curves to offset.');
  if (curves.length === 1 && curves[0].t === 'circle') {
    const c = curves[0];
    if (c.r + d <= 0) throw new Error('That offset is bigger than the circle.');
    pushCurve(sk, { t: 'circle', c: c.c, r: c.r + d });
    return;
  }
  if (curves.some((c) => c.t === 'circle')) throw new Error('Offset a circle on its own.');
  const { chain, closed } = chainOf(sk, curves);
  // Offset to the left of the chain's direction; for a counter-clockwise loop that is inward, so flip.
  let side = d;
  if (closed) {
    let area = 0;
    for (const { from, to } of chain) { const a = M.xy(sk, from), b = M.xy(sk, to); area += cross(a, b); }
    if (area > 0) side = -d;
  }
  // Each piece's offset start and end.
  const pieces = chain.map(({ c, from, to }) => {
    const A = M.xy(sk, from), B = M.xy(sk, to);
    if (c.t === 'line') {
      const n = mul([-(B[1] - A[1]), B[0] - A[0]], side / (Math.hypot(B[0] - A[0], B[1] - A[1]) || 1));
      return { c, a: add(A, n), b: add(B, n) };
    }
    // An arc walked from s to e turns left (towards its centre); walked backwards it turns right.
    const C = M.xy(sk, c.c), forward = from === c.s;
    const g = M.arcGeom(sk, c), r = g.r + (forward ? -side : side);
    if (r <= 1e-6) throw new Error('That offset is bigger than an arc in the chain.');
    const on = (P) => add(C, mul(unit([P[0] - C[0], P[1] - C[1]]), r));
    return { c, a: on(A), b: on(B), r, forward };
  });
  // Join neighbours: where offset lines meet, or the shared end when they already touch.
  const joint = (p, q) => {
    if (G.near(p.b, q.a, 1e-6)) return p.b;
    if (p.c.t === 'line' && q.c.t === 'line') {
      const r = [p.b[0] - p.a[0], p.b[1] - p.a[1]], s = [q.b[0] - q.a[0], q.b[1] - q.a[1]], den = cross(r, s);
      if (Math.abs(den) > 1e-12) { const t = cross([q.a[0] - p.a[0], q.a[1] - p.a[1]], s) / den; return add(p.a, mul(r, t)); }
    }
    return mul(add(p.b, q.a), 0.5);
  };
  const n = pieces.length;
  const joints = [];
  for (let i = 0; i < n; i++) {
    if (i === n - 1 && !closed) break;
    joints.push(M.addPoint(sk, joint(pieces[i], pieces[(i + 1) % n])));
  }
  const startPt = closed ? joints[n - 1] : M.addPoint(sk, pieces[0].a);
  const endPt = closed ? joints[n - 1] : M.addPoint(sk, pieces[n - 1].b);
  pieces.forEach((p, i) => {
    const s = i === 0 ? startPt : joints[i - 1];
    const e = i === n - 1 ? endPt : joints[i];
    if (p.c.t === 'line') {
      const id = pushCurve(sk, { t: 'line', p1: s, p2: e });
      M.addConstraint(sk, 'parallel', [p.c.id, id]);
    } else {
      pushCurve(sk, { t: 'arc', c: p.c.c, s: p.forward ? s : e, e: p.forward ? e : s });
    }
  });
}

// ---------- project ----------

// Project a body edge (world polyline as segment pairs) onto the sketch plane as fixed geometry.
export function projectEdge(sk, frame, segPoints) {
  const toUV = (p) => {
    const d = [p[0] - frame.origin[0], p[1] - frame.origin[1], p[2] - frame.origin[2]];
    const u = d[0] * frame.xDir[0] + d[1] * frame.xDir[1] + d[2] * frame.xDir[2];
    const v = d[0] * frame.yDir[0] + d[1] * frame.yDir[1] + d[2] * frame.yDir[2];
    return [Math.round(u * 1e6) / 1e6, Math.round(v * 1e6) / 1e6];
  };
  const pts = [segPoints[0], ...segPoints.filter((_, i) => i % 2 === 1)].map(toUV);
  const first = pts[0], last = pts[pts.length - 1];
  const closed = G.near(first, last, 1e-4) && pts.length > 3;
  const made = [];
  const straight = pts.every((p) => Math.abs(cross([last[0] - first[0], last[1] - first[1]], [p[0] - first[0], p[1] - first[1]])) / (Math.hypot(last[0] - first[0], last[1] - first[1]) || 1) < 1e-4);
  if (!closed && straight) {
    made.push(pushCurve(sk, { t: 'line', p1: pointAt(sk, first), p2: pointAt(sk, last) }));
  } else {
    const m = pts[Math.floor(pts.length / 2)];
    const circ = closed ? G.circleThrough(pts[0], pts[Math.floor(pts.length / 3)], pts[Math.floor((2 * pts.length) / 3)]) : G.circleThrough(first, m, last);
    const round = circ && pts.every((p) => Math.abs(Math.hypot(p[0] - circ.c[0], p[1] - circ.c[1]) - circ.r) < 1e-3);
    if (round && closed) {
      made.push(pushCurve(sk, { t: 'circle', c: pointAt(sk, circ.c), r: circ.r }));
    } else if (round) {
      made.push(arcVia(sk, pointAt(sk, circ.c), pointAt(sk, first), pointAt(sk, last), m));
    } else {
      // Anything else (a spline seen at an angle) comes in as a chain of short lines.
      let prev = pointAt(sk, first);
      for (const p of pts.slice(1)) { const q = pointAt(sk, p); if (q !== prev) made.push(pushCurve(sk, { t: 'line', p1: prev, p2: q })); prev = q; }
    }
  }
  if (made.length) M.addConstraint(sk, 'fix', made);
  return made;
}
