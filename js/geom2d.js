// 2D curve maths shared by sketch tools (trim) and profile building (crossing shapes).
// Shapes: { t: 'line', a, b } | { t: 'circle', c, r } | { t: 'arc', c, r, a0, a1 } (counter-clockwise, a0 < a1).

export const TAU = 2 * Math.PI;
const EPS = 1e-9;

// Profile entities (lines, circles, three-point arcs) as shapes. Arcs come out counter-clockwise.
export function toShape(e) {
  if (e.t === 'line') return { t: 'line', a: e.a, b: e.b };
  if (e.t === 'circle') return { t: 'circle', c: e.c, r: e.r };
  const circ = circleThrough(e.a, e.m, e.b);
  if (!circ) return { t: 'line', a: e.a, b: e.b };
  const ang = (p) => Math.atan2(p[1] - circ.c[1], p[0] - circ.c[0]);
  let a0 = ang(e.a), a1 = ang(e.b);
  const am = norm(ang(e.m) - a0), ab = norm(a1 - a0);
  if (am > ab) [a0, a1] = [a1, a0]; // m isn't on the counter-clockwise way from a to b
  while (a1 <= a0) a1 += TAU;
  return { t: 'arc', c: circ.c, r: circ.r, a0, a1 };
}

export const norm = (t) => ((t % TAU) + TAU) % TAU;

export function circleThrough(a, m, b) {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return null;
  const sa = a[0] ** 2 + a[1] ** 2, sm = m[0] ** 2 + m[1] ** 2, sb = b[0] ** 2 + b[1] ** 2;
  const cx = (sa * (m[1] - b[1]) + sm * (b[1] - a[1]) + sb * (a[1] - m[1])) / d;
  const cy = (sa * (b[0] - m[0]) + sm * (a[0] - b[0]) + sb * (m[0] - a[0])) / d;
  return { c: [cx, cy], r: Math.hypot(a[0] - cx, a[1] - cy) };
}

// Angle of p on an arc, lifted into [a0, a0 + 2π).
const arcAngle = (s, p) => { let t = Math.atan2(p[1] - s.c[1], p[0] - s.c[0]); while (t < s.a0 - 1e-9) t += TAU; while (t >= s.a0 + TAU - 1e-9) t -= TAU; return t; };
const onArc = (s, p) => s.t !== 'arc' || arcAngle(s, p) <= s.a1 + 1e-9;

// Where along a shape a point on it lies: 0..1 for lines, an angle for circles and arcs.
export function paramOf(s, p) {
  if (s.t === 'line') {
    const d = [s.b[0] - s.a[0], s.b[1] - s.a[1]];
    return ((p[0] - s.a[0]) * d[0] + (p[1] - s.a[1]) * d[1]) / ((d[0] ** 2 + d[1] ** 2) || 1);
  }
  if (s.t === 'circle') return norm(Math.atan2(p[1] - s.c[1], p[0] - s.c[0]));
  return arcAngle(s, p);
}

export function pointAt(s, t) {
  if (s.t === 'line') return [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
  return [s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)];
}

function lineCircle(l, c) {
  const d = [l.b[0] - l.a[0], l.b[1] - l.a[1]], f = [l.a[0] - c.c[0], l.a[1] - c.c[1]];
  const A = d[0] ** 2 + d[1] ** 2, B = 2 * (f[0] * d[0] + f[1] * d[1]), C = f[0] ** 2 + f[1] ** 2 - c.r ** 2;
  const disc = B * B - 4 * A * C;
  if (disc < -1e-9 || A < EPS) return [];
  const s = Math.sqrt(Math.max(0, disc));
  const ts = disc < 1e-12 ? [-B / (2 * A)] : [(-B - s) / (2 * A), (-B + s) / (2 * A)];
  return ts.filter((t) => t > -1e-9 && t < 1 + 1e-9).map((t) => pointAt(l, t)).filter((p) => onArc(c, p));
}

function circleCircle(a, b) {
  const dx = b.c[0] - a.c[0], dy = b.c[1] - a.c[1], d = Math.hypot(dx, dy);
  if (d < EPS || d > a.r + b.r + 1e-9 || d < Math.abs(a.r - b.r) - 1e-9) return [];
  const x = (d * d + a.r * a.r - b.r * b.r) / (2 * d), h = Math.sqrt(Math.max(0, a.r * a.r - x * x));
  const m = [a.c[0] + (dx * x) / d, a.c[1] + (dy * x) / d];
  const pts = h < 1e-9 ? [m] : [[m[0] - (dy * h) / d, m[1] + (dx * h) / d], [m[0] + (dy * h) / d, m[1] - (dx * h) / d]];
  return pts.filter((p) => onArc(a, p) && onArc(b, p));
}

export function intersect(s1, s2) {
  if (s1.t === 'line' && s2.t === 'line') {
    const r = [s1.b[0] - s1.a[0], s1.b[1] - s1.a[1]], q = [s2.b[0] - s2.a[0], s2.b[1] - s2.a[1]];
    const den = r[0] * q[1] - r[1] * q[0];
    if (Math.abs(den) < EPS) return [];
    const w = [s2.a[0] - s1.a[0], s2.a[1] - s1.a[1]];
    const t = (w[0] * q[1] - w[1] * q[0]) / den, u = (w[0] * r[1] - w[1] * r[0]) / den;
    return t > -1e-9 && t < 1 + 1e-9 && u > -1e-9 && u < 1 + 1e-9 ? [pointAt(s1, t)] : [];
  }
  if (s1.t === 'line') return lineCircle(s1, s2);
  if (s2.t === 'line') return lineCircle(s2, s1);
  return circleCircle(s1, s2);
}

// Ends of a shape (none for a full circle).
export function endsOf(s) {
  if (s.t === 'line') return [s.a, s.b];
  if (s.t === 'arc') return [pointAt(s, s.a0), pointAt(s, s.a1)];
  return [];
}

export const near = (p, q, tol = 1e-6) => Math.hypot(p[0] - q[0], p[1] - q[1]) < tol;
