// Click-and-drag creation and resize arrows for primitives, and Extrude's distance arrow.
// Pure geometry: the feature dialog owns the mouse and the arrows on screen.

import { buildProfiles, sketchFrame, toWorld } from './profiles.js';

const add = (a, b) => a.map((v, i) => v + b[i]);
const mul = (a, s) => a.map((v) => v * s);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const neg = (a) => mul(a, -1);

// What each drag step sets: step 1 from the mouse on the placement plane, step 2 along its normal.
export const STAGES = {
  box: [[['width', 'Width'], ['depth', 'Depth']], [['height', 'Height']]],
  cylinder: [[['diameter', 'Ø']], [['height', 'Height']]],
  cone: [[['bottomDiameter', 'Ø']], [['height', 'Height']]],
  sphere: [[['diameter', 'Ø']]],
  torus: [[['ringDiameter', 'Ring Ø']], [['tubeDiameter', 'Tube Ø']]],
};

export const snap = (v, step) => Math.max(step, Math.round(Math.abs(v) / step) * step);
const clean = (v) => Math.round(v * 1000) / 1000;

// Placement frame of a primitive: x and y across the plane, n the direction it grows.
export function primFrame(p) {
  const sign = (p.flip ? -1 : 1) * (p.op === 'cut' ? -1 : 1);
  return { c: p.point, x: p.xDir, y: cross(p.normal, p.xDir), n: mul(p.normal, sign) };
}

// Step 1: the mouse at (u, v) on the plane, relative to the first click.
export function dragSize(type, p, start, [u, v], step) {
  const { x, y } = primFrame({ ...p, point: start });
  if (type === 'box') {
    p.width = clean(snap(u, step));
    p.depth = clean(snap(v, step));
    // The first click is a corner; the stored point is the box's centre.
    const su = Math.sign(u) || 1, sv = Math.sign(v) || 1;
    p.point = add(add(start, mul(x, (su * p.width) / 2)), mul(y, (sv * p.depth) / 2)).map(clean);
    return;
  }
  const d = clean(snap(2 * Math.hypot(u, v), step));
  p[{ cylinder: 'diameter', cone: 'bottomDiameter', sphere: 'diameter', torus: 'ringDiameter' }[type]] = d;
}

// Step 2: `t` is the mouse's distance along the plane normal (for a torus, (u, v) on the plane).
export function dragHeight(type, p, t, uv, step) {
  if (type === 'torus') {
    p.tubeDiameter = clean(snap(2 * Math.abs(Math.hypot(...uv) - p.ringDiameter / 2), step));
    return;
  }
  p.height = clean(snap(t, step));
  // Grow toward the mouse: flip so that the growth direction matches the sign of t.
  const cutSign = p.op === 'cut' ? -1 : 1;
  p.flip = Math.sign(t || 1) * cutSign < 0;
}

// Typed values for step 1 of a box keep the corner on the side the mouse is on.
export function typedSize(type, p, start, vals, [u, v]) {
  if (type !== 'box') { dragSize(type, p, start, [vals[0] / 2, 0], 0.001); return; }
  dragSize(type, p, start, [(Math.sign(u) || 1) * vals[0], (Math.sign(v) || 1) * vals[1]], 0.001);
}

// Resize arrows on a placed primitive: { key, pos, dir }.
export function primArrows(type, p) {
  if (!p.point || !p.normal) return [];
  const { c, x, y, n } = primFrame(p);
  const at = (...terms) => terms.reduce((acc, [dir, s]) => add(acc, mul(dir, s)), c);
  const h = Number(p.height) || 0;
  switch (type) {
    case 'box': return [
      { key: 'width', pos: at([x, p.width / 2], [n, h / 2]), dir: x },
      { key: 'depth', pos: at([y, p.depth / 2], [n, h / 2]), dir: y },
      { key: 'height', pos: at([n, h]), dir: n },
    ];
    case 'cylinder': return [
      { key: 'diameter', pos: at([x, p.diameter / 2], [n, h / 2]), dir: x },
      { key: 'height', pos: at([n, h]), dir: n },
    ];
    case 'cone': return [
      { key: 'bottomDiameter', pos: at([x, p.bottomDiameter / 2]), dir: x },
      { key: 'topDiameter', pos: at([x, (Number(p.topDiameter) || 0) / 2], [n, h]), dir: x },
      { key: 'height', pos: at([n, h]), dir: n },
    ];
    case 'sphere': return [{ key: 'diameter', pos: at([x, p.diameter / 2]), dir: x }];
    case 'torus': return [
      { key: 'ringDiameter', pos: at([x, p.ringDiameter / 2 + p.tubeDiameter / 2]), dir: x },
      { key: 'tubeDiameter', pos: at([x, p.ringDiameter / 2], [n, p.tubeDiameter / 2]), dir: n },
    ];
  }
  return [];
}

// Dragging arrow `key` by `amt` mm, from the params at the start of the drag.
export function applyPrimArrow(type, p, start, key, amt, step) {
  const s = (v) => clean(Math.round(v / step) * step);
  if (type === 'box' && (key === 'width' || key === 'depth')) {
    // Move one side; the opposite side stays put.
    const size = Math.max(step, s(start[key] + amt));
    const { x, y } = primFrame(start);
    p[key] = size;
    p.point = add(start.point, mul(key === 'width' ? x : y, (size - start[key]) / 2)).map(clean);
  } else if (key === 'height') {
    p.height = Math.max(step, s(start.height + amt));
  } else if (key === 'topDiameter') {
    p.topDiameter = Math.max(0, s((Number(start.topDiameter) || 0) + 2 * amt));
  } else {
    p[key] = Math.max(step, s(start[key] + 2 * amt));
  }
}

// Extrude's distance arrow, at the middle of the chosen profiles.
export function extrudeArrow(app, p) {
  const sk = app.featureById(p.sketch);
  if (!sk) return null;
  const { loops, regions } = buildProfiles(sk.params.entities);
  const picked = p.profiles === 'all' ? regions : p.profiles.map((i) => regions[i]).filter(Boolean);
  const pts = picked.flatMap((r) => loops[r.outer].poly);
  if (!pts.length) return null;
  const mid = (k) => (Math.min(...pts.map((q) => q[k])) + Math.max(...pts.map((q) => q[k]))) / 2;
  const u = mid(0), v = mid(1);
  const frame = sketchFrame(sk.params);
  const d = Number(p.distance) || 0;
  const reach = p.direction === 'symmetric' ? Math.abs(d) / 2 : d;
  const pos = add(toWorld(frame, u, v), mul(frame.normal, reach));
  // Point the arrow the way the extrude goes, so dragging outward always makes it longer.
  const dir = p.direction !== 'symmetric' && d < 0 ? neg(frame.normal) : frame.normal;
  return { key: 'distance', pos, dir };
}

export function applyExtrudeArrow(p, start, amt, step) {
  const s = (v) => clean(Math.round(v / step) * step);
  const d0 = Number(start.distance) || 0;
  if (p.direction === 'symmetric') { p.distance = Math.max(step, s(Math.abs(d0) + 2 * amt)); return; }
  const sign = d0 < 0 ? -1 : 1;
  p.distance = sign * Math.max(step, s(Math.abs(d0) + amt));
}
