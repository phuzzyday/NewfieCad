// Sketch constraint solving with planegcs, FreeCAD's 2D solver compiled to WebAssembly
// (LGPL 2.1, kept in ../lib with the other libraries).

import { arcGeom, curveById, curvePoints, pointById } from './sketch-model.js';

const BASE = new URL('../lib/planegcs/dist/', import.meta.url).href;
let solver = null;
let loading = null;

// Start loading early; solving before it is ready leaves the sketch as drawn.
export function loadSolver() {
  loading ??= (async () => {
    const m = await import(`${BASE}index.js`);
    const mod = await m.init_planegcs_module({ locateFile: (f) => `${BASE}planegcs_dist/${f}` });
    solver = new m.GcsWrapper(new mod.GcsSystem());
  })();
  return loading;
}

const DEG = Math.PI / 180;
const kindOf = (sk, id) => curveById(sk, id)?.t;

// planegcs's own line-arc tangency doesn't hold in this build. Where the line and arc share
// an end, keep the line square to the radius there; otherwise keep the line's distance from
// the centre equal to the radius.
function lineArcTangent(sk, id, lineId, arcId) {
  const l = curveById(sk, lineId), arc = curveById(sk, arcId);
  const shared = [l.p1, l.p2].find((p) => p === arc.s || p === arc.e);
  if (shared) return [{ id, type: 'perpendicular_pppp', l1p1_id: l.p1, l1p2_id: l.p2, l2p1_id: arc.c, l2p2_id: shared }];
  return [{ id, type: 'p2l_distance', p_id: arc.c, l_id: lineId, distance: { o_id: arcId, prop: 'radius' } }];
}

// One sketch constraint as planegcs constraints.
function toGcs(sk, k) {
  const [a, b] = k.refs;
  const id = k.id;
  const ka = kindOf(sk, a), kb = kindOf(sk, b);
  switch (k.type) {
    case 'horizontal': return ka === 'line' ? [{ id, type: 'horizontal_l', l_id: a }] : [{ id, type: 'horizontal_pp', p1_id: a, p2_id: b }];
    case 'vertical': return ka === 'line' ? [{ id, type: 'vertical_l', l_id: a }] : [{ id, type: 'vertical_pp', p1_id: a, p2_id: b }];
    case 'parallel': return [{ id, type: 'parallel', l1_id: a, l2_id: b }];
    case 'perpendicular': return [{ id, type: 'perpendicular_ll', l1_id: a, l2_id: b }];
    case 'tangent': {
      const pair = `${ka}-${kb}`;
      if (pair === 'line-circle') return [{ id, type: 'tangent_lc', l_id: a, c_id: b }];
      if (pair === 'circle-line') return [{ id, type: 'tangent_lc', l_id: b, c_id: a }];
      if (pair === 'line-arc' || pair === 'arc-line') return lineArcTangent(sk, id, ka === 'line' ? a : b, ka === 'line' ? b : a);
      if (pair === 'circle-circle') return [{ id, type: 'tangent_cc', c1_id: a, c2_id: b }];
      if (pair === 'circle-arc') return [{ id, type: 'tangent_ca', c_id: a, a_id: b }];
      if (pair === 'arc-circle') return [{ id, type: 'tangent_ca', c_id: b, a_id: a }];
      return [{ id, type: 'tangent_aa', a1_id: a, a2_id: b }];
    }
    case 'equal': {
      if (ka === 'line') return [{ id, type: 'equal_length', l1_id: a, l2_id: b }];
      if (ka === 'circle' && kb === 'circle') return [{ id, type: 'equal_radius_cc', c1_id: a, c2_id: b }];
      if (ka === 'circle') return [{ id, type: 'equal_radius_ca', c1_id: a, a2_id: b }];
      if (kb === 'circle') return [{ id, type: 'equal_radius_ca', c1_id: b, a2_id: a }];
      return [{ id, type: 'equal_radius_aa', a1_id: a, a2_id: b }];
    }
    case 'onCurve':
      if (kb === 'line') return [{ id, type: 'point_on_line_pl', p_id: a, l_id: b }];
      if (kb === 'circle') return [{ id, type: 'point_on_circle', p_id: a, c_id: b }];
      return [{ id, type: 'point_on_arc', p_id: a, a_id: b }];
    case 'midpoint': {
      const l = curveById(sk, b);
      return [{ id, type: 'p2p_symmetric_ppp', p1_id: l.p1, p2_id: l.p2, p_id: a }];
    }
    case 'distance': return [{ id, type: 'p2p_distance', p1_id: a, p2_id: b, distance: k.value }];
    case 'length': { const l = curveById(sk, a); return [{ id, type: 'p2p_distance', p1_id: l.p1, p2_id: l.p2, distance: k.value }]; }
    case 'pointLine': return [{ id, type: 'p2l_distance', p_id: a, l_id: b, distance: k.value }];
    case 'diameter': return [{ id, type: 'circle_diameter', c_id: a, diameter: k.value }];
    case 'radius': return [{ id, type: 'arc_radius', a_id: a, radius: k.value }];
    case 'angle': return [{ id, type: 'l2l_angle_ll', l1_id: a, l2_id: b, angle: (k.sign || 1) * k.value * DEG }];
  }
  return []; // 'fix' is applied by fixing the points
}

// Points held still by Fix constraints.
export function fixedPoints(sk) {
  const out = new Set();
  for (const k of sk.constraints) {
    if (k.type !== 'fix') continue;
    for (const r of k.refs) {
      if (pointById(sk, r)) out.add(r);
      else { const c = curveById(sk, r); if (c) curvePoints(c).forEach((p) => out.add(p)); }
    }
  }
  return out;
}

function primitives(sk, { extra = [], pinned = new Set(), skip = null } = {}) {
  const fixed = fixedPoints(sk);
  const out = sk.points.map((p) => ({ id: p.id, type: 'point', x: p.x, y: p.y, fixed: fixed.has(p.id) || pinned.has(p.id) }));
  for (const c of sk.curves) {
    if (c.t === 'line') out.push({ id: c.id, type: 'line', p1_id: c.p1, p2_id: c.p2 });
    else if (c.t === 'circle') out.push({ id: c.id, type: 'circle', c_id: c.c, radius: c.r });
    else {
      const g = arcGeom(sk, c);
      out.push({ id: c.id, type: 'arc', c_id: c.c, radius: g.r, start_angle: g.a0, end_angle: g.a1, start_id: c.s, end_id: c.e },
        { id: `${c.id}_rules`, type: 'arc_rules', a_id: c.id });
    }
  }
  for (const k of sk.constraints) if (k.id !== skip) out.push(...toGcs(sk, k));
  // A fixed circle keeps its size as well as its centre.
  for (const k of sk.constraints) {
    if (k.type !== 'fix') continue;
    for (const r of k.refs) {
      const c = curveById(sk, r);
      if (c?.t === 'circle') out.push({ id: `${k.id}_${r}`, type: 'circle_radius', c_id: r, radius: c.r });
    }
  }
  return out.concat(extra);
}

const ok = (status) => status === 0 || status === 1;

// Solve in place. `extra` adds temporary pull constraints (dragging). Returns
// { ok, conflicting, redundant }; on failure the sketch is left unchanged.
export function solve(sk, extra = []) {
  if (!solver) return { ok: true, pending: true };
  solver.clear_data();
  solver.push_primitives_and_params(primitives(sk, { extra }));
  const status = solver.solve();
  const conflicting = solver.get_gcs_conflicting_constraints();
  const redundant = solver.get_gcs_redundant_constraints();
  if (!ok(status) || conflicting.length) return { ok: false, conflicting, redundant };
  solver.apply_solution();
  for (const p of solver.sketch_index.get_primitives()) {
    if (p.type === 'point') { const q = pointById(sk, p.id); if (q) { q.x = p.x; q.y = p.y; } }
    else if (p.type === 'circle') { const c = curveById(sk, p.id); if (c) c.r = p.radius; }
  }
  return { ok: true, conflicting, redundant };
}

// Degrees of freedom left, after solving with the given extra settings.
function dof(sk, opts) {
  solver.clear_data();
  solver.push_primitives_and_params(primitives(sk, opts));
  solver.solve();
  return solver.gcs.dof();
}

// Which points and curves can no longer move (Fusion draws these black), and how many
// degrees of freedom are left. A point is fixed when pinning it doesn't lower the count.
export function analyse(sk) {
  if (!solver) return { dof: null, fixed: new Set() };
  const total = dof(sk);
  const fixed = new Set();
  if (total === 0) {
    sk.points.forEach((p) => fixed.add(p.id));
    sk.curves.forEach((c) => fixed.add(c.id));
    return { dof: 0, fixed };
  }
  for (const p of sk.points) if (dof(sk, { pinned: new Set([p.id]) }) === total) fixed.add(p.id);
  for (const c of sk.curves) {
    if (!curvePoints(c).every((p) => fixed.has(p))) continue;
    // A circle also needs its size held: adding a radius constraint mustn't lower the count.
    if (c.t === 'circle' && dof(sk, { extra: [{ id: '_probe', type: 'circle_radius', c_id: c.id, radius: c.r }] }) !== total) continue;
    fixed.add(c.id);
  }
  return { dof: total, fixed };
}

// Pull points toward targets while dragging: { pointId: [x, y] } -> temporary constraints.
export function dragTargets(targets) {
  return Object.entries(targets).flatMap(([id, [x, y]]) => [
    { id: `_dx_${id}`, type: 'coordinate_x', p_id: id, x, temporary: true },
    { id: `_dy_${id}`, type: 'coordinate_y', p_id: id, y, temporary: true },
  ]);
}

export function dragRadius(curveId, r) {
  return [{ id: `_r_${curveId}`, type: 'circle_radius', c_id: curveId, radius: r, temporary: true }];
}
