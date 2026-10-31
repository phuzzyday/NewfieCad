// Snapping for points placed on a plane (a primitive's corners, a hole's centre): body
// corners, edge midpoints, circle centres and edges lying in that plane, and the origin
// and its axes. Targets are caught within a few pixels of the mouse, at any zoom.

import * as THREE from 'three';

const RADIUS_PX = 12;
const TOL = 1e-3; // mm off the plane that still counts as on it
const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const LABELS = { corner: 'Corner', mid: 'Midpoint', center: 'Centre', edge: 'On edge', origin: 'Origin' };

const V = (p) => new THREE.Vector3(...p);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Centre of the circle through three points, or null if they are in a line.
function centre3(a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), n = cross(ab, ac), n2 = dot(n, n);
  if (n2 < 1e-9 * dot(ab, ab) * dot(ac, ac)) return null;
  const t = cross(n, ab).map((v, i) => (v * dot(ac, ac) + cross(ac, n)[i] * dot(ab, ab)) / (2 * n2));
  return a.map((v, i) => v + t[i]);
}

// Snap targets on the plane through `o` with normal `n`, cached until the bodies change.
let cache = { bodies: null, key: null, value: null };
function targets(vp, o, n) {
  const key = `${n.map((v) => v.toFixed(5))}|${dot(o, n).toFixed(4)}`;
  if (cache.bodies === vp.bodyData && cache.key === key) return cache.value;
  const off = (p) => Math.abs(dot(p, n) - dot(o, n));
  const points = [], segs = [];
  for (const b of vp.bodyData) {
    if (!b.lines || !b.edgeGroups) continue;
    b.edgeGroups.forEach((_, gi) => {
      const pts = vp.edgePoints(b, gi);
      if (pts.length < 2 || !pts.every((p) => off(p) < TOL)) return;
      for (let i = 0; i + 1 < pts.length; i += 2) segs.push({ a: pts[i], b: pts[i + 1], kind: 'edge' });
      // A curved edge (an arc, or part of a circle): its centre.
      const c = pts.length > 2 && centre3(pts[0], pts[Math.floor(pts.length / 3)], pts[Math.floor((2 * pts.length) / 3)]);
      if (c) points.push({ p: c, kind: 'center' });
      const first = pts[0], last = pts.at(-1);
      if (dist(first, last) < TOL) return; // a whole circle has no ends or middle
      points.push({ p: first, kind: 'corner' }, { p: last, kind: 'corner' });
      // The point halfway along the edge.
      let total = 0;
      for (let i = 0; i + 1 < pts.length; i += 2) total += dist(pts[i], pts[i + 1]);
      let run = 0;
      for (let i = 0; i + 1 < pts.length; i += 2) {
        const l = dist(pts[i], pts[i + 1]);
        if (run + l >= total / 2) {
          const t = l ? (total / 2 - run) / l : 0;
          points.push({ p: pts[i].map((v, k) => v + (pts[i + 1][k] - v) * t), kind: 'mid' });
          break;
        }
        run += l;
      }
    });
  }
  if (off([0, 0, 0]) < TOL) {
    points.push({ p: [0, 0, 0], kind: 'origin' });
    AXES.forEach((d, k) => {
      if (Math.abs(dot(d, n)) < 1e-6) segs.push({ a: d.map((v) => -1e4 * v), b: d.map((v) => 1e4 * v), kind: 'axis', name: 'XYZ'[k] });
    });
  }
  cache = { bodies: vp.bodyData, key, value: { points, segs } };
  return cache.value;
}

// The snapped point near the mouse on that plane: { point, kind, label }, or null.
// Points (corners, midpoints, centres, the origin) win over edges and axes.
export function snapPoint(vp, ev, o, n) {
  const { points, segs } = targets(vp, o, n);
  const near = (p) => {
    const [x, y] = vp.toScreen(p);
    return Math.hypot(x - ev.clientX, y - ev.clientY);
  };
  let best = null, bestD = RADIUS_PX;
  for (const t of points) {
    const d = near(t.p);
    if (d < bestD) { best = { point: t.p, kind: t.kind }; bestD = d; }
  }
  if (!best) {
    const ray = vp.ray(ev).ray, onSeg = new THREE.Vector3();
    for (const s of segs) {
      ray.distanceSqToSegment(V(s.a), V(s.b), null, onSeg);
      const p = onSeg.toArray(), d = near(p);
      if (d < bestD) { best = { point: p, kind: s.kind, axis: s.name }; bestD = d; }
    }
  }
  if (!best) return null;
  best.point = best.point.map((v) => Math.round(v * 1000) / 1000);
  best.label = best.kind === 'axis' ? `On ${best.axis} axis` : LABELS[best.kind];
  return best;
}
