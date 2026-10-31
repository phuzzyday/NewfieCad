// Geometry kernel worker: replays the feature timeline with replicad (OpenCascade)
// and sends back triangle and edge meshes for display and export.

// Libraries are kept in ../lib (see fetch_libs.py), so no internet is needed.
import opencascade from '../lib/replicad-opencascadejs/dist/replicad_single.js';
import * as R from '../lib/replicad/dist/replicad.js';
import { buildProfiles, sketchFrame, curveChain, toWorld, rectCorners } from './profiles.js';
import { decodeMesh, meshToSTL } from './stl.js';
import { threadById, nearestThread, fitDiameter } from './threads.js';

const WASM_URL = new URL('../lib/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url).href;

const DISPLAY_MESH = { tolerance: 0.02, angularTolerance: 0.15 };
// Bodies with more edges than this (typically imported STLs) are drawn without edge lines.
const MAX_EDGE_LINES = 5000;
const EXPORT_MESH = { tolerance: 0.005, angularTolerance: 0.08 };

const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const mul = (a, s) => a.map((v) => v * s);
const len = (a) => Math.hypot(...a);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---------- sketch -> replicad drawings ----------

function loopDrawing(loop) {
  const s0 = loop.segs[0];
  if (s0.t === 'circle') return R.drawCircle(s0.r).translate(s0.c[0], s0.c[1]);
  let pen = R.draw(s0.a);
  for (const s of loop.segs) {
    pen = s.t === 'arc' ? pen.threePointsArcTo(s.b, s.m) : pen.lineTo(s.b);
  }
  return pen.close();
}

function regionDrawings(sketch, selection) {
  const { loops, regions } = buildProfiles(sketch.entities);
  if (!regions.length) throw new Error('Sketch has no closed profile');
  const picked = selection === 'all' || !selection?.length
    ? regions
    : selection.map((i) => regions[i]).filter(Boolean);
  if (!picked.length) throw new Error('Selected profiles no longer exist');
  return picked.map((r) => {
    let d = loopDrawing(loops[r.outer]);
    for (const h of r.holes) d = d.cut(loopDrawing(loops[h]));
    return d;
  });
}

function makePlane(frame) {
  return new R.Plane(frame.origin, frame.xDir, frame.normal);
}

// ---------- features ----------

function fuseAll(shapes) {
  return shapes.reduce((acc, s) => (acc ? acc.fuse(s) : s), null);
}

function boxesOverlap(a, b) {
  const [amin, amax] = a.boundingBox.bounds, [bmin, bmax] = b.boundingBox.bounds;
  return [0, 1, 2].every((k) => amin[k] <= bmax[k] + 1e-6 && bmin[k] <= amax[k] + 1e-6);
}

// Cut only the bodies the tool can reach; cutting a body it doesn't touch can
// leave that body unmeshable.
function cutBodies(state, tool) {
  state.bodies = state.bodies.map((b) => (boxesOverlap(b.shape, tool) ? { ...b, shape: b.shape.cut(tool) } : b));
}

function applyBodyOp(state, featureId, tool, op, name = null) {
  if (op === 'cut') {
    if (!state.bodies.length) throw new Error('Nothing to cut');
    cutBodies(state, tool);
  } else if (op === 'join' && state.bodies.length) {
    // Join into the first body the tool touches, or the newest body.
    let i = state.bodies.findIndex((b) => boxesOverlap(b.shape, tool));
    if (i < 0) i = state.bodies.length - 1;
    const target = state.bodies[i];
    state.bodies = state.bodies.map((b, k) => (k === i ? { ...target, shape: target.shape.fuse(tool) } : b));
  } else {
    state.bodyCount += 1;
    state.bodies = [...state.bodies, { id: featureId, name: name || `Body${state.bodyCount}`, shape: tool }];
  }
}

function getSketch(state, id) {
  const sk = state.sketches.get(id);
  if (!sk) throw new Error('Its sketch is missing or suppressed');
  return sk;
}

function extrudeTool(state, f) {
  const p = f.params;
  const sk = getSketch(state, p.sketch);
  let d = Number(p.distance) || 0;
  if (Math.abs(d) < 1e-6) throw new Error('Distance cannot be zero');
  const frame = sketchFrame(sk);
  let shift = 0;
  if (p.direction === 'symmetric') { shift = -Math.abs(d) / 2; d = Math.abs(d); }
  else if (d < 0) { shift = d; d = -d; }
  const shifted = { ...frame, origin: add(frame.origin, mul(frame.normal, shift)) };
  const solids = regionDrawings(sk, p.profiles).map((dr) => dr.sketchOnPlane(makePlane(shifted)).extrude(d));
  return { tool: fuseAll(solids), op: p.op };
}

function revolveTool(state, f) {
  const p = f.params;
  const sk = getSketch(state, p.sketch);
  const frame = sketchFrame(sk);
  const axis = p.axis === 'x' ? frame.xDir : frame.yDir;
  const angle = Number(p.angle) || 360;
  const solids = regionDrawings(sk, p.profiles).map((dr) =>
    dr.sketchOnPlane(makePlane(frame)).revolve(axis, { origin: frame.origin, angle }));
  return { tool: fuseAll(solids), op: p.op };
}

// One profile (region) of a sketch as wires in 3D: its outline and its holes.
function regionWires(state, ref) {
  const sk = getSketch(state, ref.sketch);
  const { loops, regions } = buildProfiles(sk.entities);
  const r = regions[ref.index];
  if (!r) throw new Error('A picked profile no longer exists');
  const wire = (li) => loopDrawing(loops[li]).sketchOnPlane(makePlane(sketchFrame(sk))).wire;
  return { outer: wire(r.outer), holes: r.holes.map(wire) };
}

// Loft: blend between the outlines of two or more profiles, in the order picked.
function loftTool(state, f) {
  const p = f.params;
  if ((p.sections || []).length < 2) throw new Error('Pick at least two profiles');
  const wires = p.sections.map((s) => regionWires(state, s).outer);
  return { tool: R.loft(wires, { ruled: !!p.ruled }), op: p.op };
}

// A sweep path: the chain of curves through the picked one, as a 3D wire.
function pathWire(state, ref) {
  const sk = getSketch(state, ref.sketch);
  const chain = curveChain(sk.entities, ref.index);
  if (!chain) throw new Error('The path curve no longer exists');
  const fr = sketchFrame(sk);
  const w = (p) => toWorld(fr, p[0], p[1]);
  const edges = chain.items.flatMap(({ e, rev }) => {
    switch (e.t) {
      case 'line': return [rev ? R.makeLine(w(e.b), w(e.a)) : R.makeLine(w(e.a), w(e.b))];
      case 'arc': return [rev ? R.makeThreePointArc(w(e.b), w(e.m), w(e.a)) : R.makeThreePointArc(w(e.a), w(e.m), w(e.b))];
      case 'circle': return [R.makeCircle(e.r, w(e.c), fr.normal)];
      case 'rect': {
        const c = rectCorners(e).map(w);
        return c.map((p, i) => R.makeLine(p, c[(i + 1) % 4]));
      }
    }
    return [];
  });
  return R.assembleWire(edges);
}

// Sweep: move a profile along a path. Holes in the profile are swept too and cut out.
function sweepTool(state, f) {
  const p = f.params;
  if (!p.profile) throw new Error('Click a profile to sweep');
  if (!p.path) throw new Error('Click a curve for the path');
  const { outer, holes } = regionWires(state, p.profile);
  const spine = pathWire(state, p.path);
  const opts = { transitionMode: p.corners === 'round' ? 'round' : 'right' };
  let tool = R.genericSweep(outer, spine, opts);
  for (const h of holes) tool = tool.cut(R.genericSweep(h, spine, opts));
  return { tool, op: p.op };
}

function edgeSig(e) {
  return { s: e.startPoint.toTuple(), e: e.endPoint.toTuple(), m: e.pointAt(0.5).toTuple() };
}

function edgeScore(sig, cand) {
  const ends = Math.min(
    len(sub(sig.s, cand.s)) + len(sub(sig.e, cand.e)),
    len(sub(sig.s, cand.e)) + len(sub(sig.e, cand.s)));
  return len(sub(sig.m, cand.m)) + ends;
}

// Find the edges referenced by geometric signatures, grouped by body index.
function matchEdges(state, sigs, warnings) {
  const all = [];
  state.bodies.forEach((b, bi) => b.shape.edges.forEach((e) => all.push({ bi, e, sig: edgeSig(e) })));
  const out = new Map();
  for (const sig of sigs) {
    let best = null, bestScore = Infinity;
    for (const c of all) {
      const sc = edgeScore(sig, c.sig);
      if (sc < bestScore) { bestScore = sc; best = c; }
    }
    if (!best) continue;
    if (bestScore > 0.01) warnings.push('An edge moved, so the nearest edge was used');
    if (!out.has(best.bi)) out.set(best.bi, new Set());
    out.get(best.bi).add(best.e.hashCode);
  }
  return out;
}

function edgeFeature(state, f, method, size) {
  const sigs = f.params.edges || [];
  if (!sigs.length) throw new Error('No edges selected');
  if (!(size > 0)) throw new Error('Size must be greater than zero');
  const groups = matchEdges(state, sigs, state.warnings);
  state.bodies = state.bodies.map((b, bi) => {
    const hashes = groups.get(bi);
    if (!hashes) return b;
    return { ...b, shape: b.shape[method]((e) => (hashes.has(e.hashCode) ? size : null)) };
  });
}

function faceSig(face) {
  // Normal at the middle of the face's own parameter range. Measuring it at the
  // centre of mass fails on curved faces (a cylinder's centre is on its axis).
  const n = face.normalAt().toTuple();
  const l = len(n) || 1;
  return { c: face.center.toTuple(), n: n.map((v) => v / l) };
}

// Nearest face to a {c, n} signature, across all bodies.
function matchFace(state, sig) {
  let best = null, bestScore = Infinity;
  state.bodies.forEach((b, bi) => b.shape.faces.forEach((face) => {
    const fs = faceSig(face);
    const sc = len(sub(sig.c, fs.c)) + 10 * (1 - dot(sig.n, fs.n));
    if (sc < bestScore) { bestScore = sc; best = { bi, face, sig: fs }; }
  }));
  return best;
}

// The solids inside a shape (a compound can hold several).
function solidsOf(shape) {
  if (!(shape instanceof R.Compound)) return [shape];
  const oc = R.getOC();
  const out = [];
  const ex = new oc.TopExp_Explorer(shape.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) out.push(R.cast(oc.TopoDS.Solid(ex.Current())));
  ex.delete();
  return out;
}

// Joins often come back as a compound holding one solid. Several operations (offsets in
// particular) treat that as a surface, not a solid, so unwrap it.
function tidyBodies(state) {
  state.bodies = state.bodies.map((b) => {
    if (!(b.shape instanceof R.Compound)) return b;
    const solids = solidsOf(b.shape);
    return solids.length === 1 ? { ...b, shape: solids[0] } : b;
  });
}

// Sealed hollow: cut away a copy of the body shrunk inward by the wall thickness.
function hollow(state, p, t) {
  let ids = p.mode === 'bodies' ? p.bodies || [] : [];
  if (!ids.length) {
    if (state.bodies.length !== 1) throw new Error('Several bodies: set Type to Hollow and pick the body');
    ids = [state.bodies[0].id];
  }
  const sel = new Set(selectedBodies(state, ids).map((b) => b.id));
  state.bodies = state.bodies.map((b) => {
    if (!sel.has(b.id)) return b;
    // A hollow solid has a second (inner) skin.
    const oc = R.getOC();
    const ex = new oc.TopExp_Explorer(b.shape.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    let skins = 0;
    for (; ex.More(); ex.Next()) skins++;
    ex.delete();
    if (skins > solidsOf(b.shape).length) throw new Error(`${b.name} is already hollow.`);
    // The inside is the body shrunk by the wall thickness; a body thinner than two walls has none.
    const [min, max] = b.shape.boundingBox.bounds;
    const thin = Math.min(...[0, 1, 2].map((k) => max[k] - min[k]));
    // Each solid is shrunk on its own (an offset of a compound is only a surface).
    let inners = null;
    if (thin > 2 * t + 1e-6) {
      try { inners = solidsOf(b.shape).map((s) => R.makeOffset(s, -t)); } catch { inners = null; }
    }
    if (!inners?.length) {
      throw new Error(`Walls of ${t} mm don't fit: ${b.name} is only ${Math.round(thin * 100) / 100} mm thick. Use thinner walls.`);
    }
    return { ...b, shape: inners.reduce((s, inner) => s.cut(inner), b.shape) };
  });
}

function shell(state, f) {
  const p = f.params;
  const sigs = p.mode === 'bodies' ? [] : p.faces || [];
  const t = Number(p.thickness);
  if (!(t > 0)) throw new Error('Thickness must be greater than zero');
  if (!sigs.length) { hollow(state, p, t); return; }
  const groups = new Map();
  for (const sig of sigs) {
    const best = matchFace(state, sig);
    if (!best) continue;
    if (!groups.has(best.bi)) groups.set(best.bi, []);
    groups.get(best.bi).push(best.face);
  }
  state.bodies = state.bodies.map((b, bi) => {
    const faces = groups.get(bi);
    return faces ? { ...b, shape: b.shape.shell(t,(fnd) => fnd.inList(faces)) } : b;
  });
}

// A flat face pushed `d` along its outward normal `n`, as a solid to add (d > 0) or cut.
// A cut starts slightly outside the face, as cuts on the exact surface are unreliable.
function faceExtrusion(face, n, d, withLead = true) {
  const lead = d < 0 && withLead ? 0.05 : 0;
  return R.basicFaceExtrusion(face.clone().translate(mul(n, lead)), new R.Vector(mul(n, d - lead)));
}

// Press Pull: extrude a flat face along its normal. Outward adds to its body, inward cuts.
function pressPull(state, f) {
  const p = f.params;
  if (!p.face) throw new Error('Click a flat face');
  const d = Number(p.distance) || 0;
  if (Math.abs(d) < 1e-6) throw new Error('Distance cannot be zero');
  const m = matchFace(state, p.face);
  if (!m) throw new Error('The face is missing');
  if (m.face.geomType !== 'PLANE') throw new Error('Press Pull needs a flat face');
  const tool = faceExtrusion(m.face, p.normal || m.sig.n, d);
  state.bodies = state.bodies.map((b, i) => (i === m.bi ? { ...b, shape: d > 0 ? b.shape.fuse(tool) : b.shape.cut(tool) } : b));
}

// Move faces: every picked flat face is pushed by how far the move goes along its own
// normal (so a slot's two walls slide over together). Faces the move runs along stay
// where they are and stretch or shrink with their neighbours.
function moveFaces(state, f) {
  const p = f.params;
  if (!p.faces?.length) throw new Error('Select at least one face');
  const v = [p.dx, p.dy, p.dz].map((x) => Number(x) || 0);
  const adds = new Map(), cuts = new Map(), exact = new Map();
  const push = (map, bi, s) => { if (!map.has(bi)) map.set(bi, []); map.get(bi).push(s); };
  // Find every face before changing anything.
  for (const sig of p.faces) {
    const m = matchFace(state, sig);
    if (!m) throw new Error('A picked face is missing');
    if (m.face.geomType !== 'PLANE') throw new Error('Only flat faces can be moved');
    const d = dot(v, sig.n);
    if (Math.abs(d) < 1e-6) continue;
    if (d > 0) push(adds, m.bi, faceExtrusion(m.face, sig.n, d));
    else {
      push(cuts, m.bi, faceExtrusion(m.face, sig.n, d));
      push(exact, m.bi, faceExtrusion(m.face, sig.n, d, false));
    }
  }
  // A move longer than the feature is wide sweeps some space twice: once by a face that
  // adds and once by one that cuts (a slot's old place, or a boss's). That space keeps
  // what it had, so only the parts swept once are added or cut. (The cuts' small lead
  // is left out when trimming the additions, so no sliver is lost.)
  const solid = (s) => s && s.faces.length > 0;
  state.bodies = state.bodies.map((b, i) => {
    const A = fuseAll(adds.get(i) || []), C = fuseAll(cuts.get(i) || []);
    if (!A && !C) return b;
    const add = A && C ? A.cut(fuseAll(exact.get(i))) : A, cut = A && C ? C.cut(A) : C;
    let s = b.shape;
    if (solid(add)) s = s.fuse(add);
    if (solid(cut)) s = s.cut(cut);
    return { ...b, shape: s };
  });
}

// The axis, radius and extent of a cylindrical face, and whether it is a hole.
function cylinderOf(m) {
  const oc = R.getOC();
  const ad = new oc.BRepAdaptor_Surface(m.face.wrapped, false);
  const cyl = ad.Cylinder();
  const ax = cyl.Axis(), loc = ax.Location(), dir = ax.Direction();
  const o = [loc.X(), loc.Y(), loc.Z()], a = [dir.X(), dir.Y(), dir.Z()], r = cyl.Radius();
  const { uMin, uMax, vMin, vMax } = m.face.UVBounds;
  const pt = ad.Value((uMin + uMax) / 2, (vMin + vMax) / 2), at = [pt.X(), pt.Y(), pt.Z()];
  [pt, dir, loc, ax, cyl, ad].forEach((x) => x.delete());
  // A hole's surface faces its axis; a shaft's faces away from it.
  const radial = sub(at, add(o, mul(a, dot(sub(at, o), a))));
  const n = m.face.normalAt(at).toTuple();
  return { o, a, r, z0: vMin, z1: vMax, internal: dot(n, radial) < 0 };
}

// Thread: cut a 60° thread groove along a helix into a round face. Outside threads are
// cut down from the major diameter, inside threads out from a hole to it; the clearance
// cuts that much deeper (on the diameter) so printed parts fit together.
function thread(state, f) {
  const p = f.params;
  if (!p.face) throw new Error('Click a round face');
  const m = matchFace(state, p.face);
  if (!m) throw new Error('The face is missing');
  if (m.face.geomType !== 'CYLINDRE') throw new Error('Threads go on a round face: a shaft or a hole');
  const { o, a, r, z0, z1, internal } = cylinderOf(m);
  const t = p.size === 'auto' || !p.size ? nearestThread(2 * r, internal) : threadById(p.size);
  if (!t) throw new Error('Unknown thread size');
  const P = t.p;
  const fit = fitDiameter(t, internal);
  const round = (v) => Math.round(v * 100) / 100;
  state.note = `${t.label}, ${internal ? 'inside thread (hole)' : 'outside thread'}. Face Ø${round(2 * r)} mm`
    + (Math.abs(2 * r - fit) > 0.1 * P ? `; this size expects Ø${round(fit)} mm.` : '.');
  // Which part of the face: all of it, or `length` from the end nearest the click.
  const full = z1 - z0;
  const L = Number(p.length) > 0 ? Math.min(Number(p.length), full) : full;
  const zc = p.point ? dot(sub(p.point, o), a) : z0;
  const start = zc > (z0 + z1) / 2 ? z1 - L : z0;
  // The groove's cross-section, in the plane through the axis (x outward, y along it).
  const c = Math.max(0, Number(p.clearance) || 0) / 2;
  const h = 0.5413 * P; // 5H/8 of the basic profile, H = 0.866 P
  const e = 0.05 * P, tan30 = Math.tan(Math.PI / 6);
  const R0 = t.d / 2 + (internal ? c : -c);
  const pts = internal
    ? [[R0, -P / 16], [R0, P / 16], [R0 - h - e, P / 16 + (h + e) * tan30], [R0 - h - e, -P / 16 - (h + e) * tan30]]
    : [[R0 - h, -P / 8], [R0 - h, P / 8], [R0 + e, P / 8 + (h + e) * tan30], [R0 + e, -P / 8 - (h + e) * tan30]];
  // Sweep it along a helix that runs a pitch past each end, then keep only the threaded length.
  const base = add(o, mul(a, start - P));
  const helix = R.makeHelix(P, L + 2 * P, R0, base, a, !!p.left);
  const u0 = sub(helix.startPoint.toTuple(), base);
  const u = mul(u0, 1 / len(u0));
  let pen = R.draw(pts[0]);
  for (const q of pts.slice(1)) pen = pen.lineTo(q);
  const profile = pen.close().sketchOnPlane(new R.Plane(base, u, cross(u, a))).wire;
  const groove = R.genericSweep(profile, helix, { frenet: true });
  const slab = R.makeCylinder(t.d / 2 + 2 * P, L, add(o, mul(a, start)), a);
  const cut = groove.intersect(slab);
  state.bodies = state.bodies.map((b, i) => (i === m.bi ? { ...b, shape: b.shape.cut(cut) } : b));
}

// Placement point of a hole or primitive. If it was placed on a face, it follows
// that face, so it stays on the surface when the face moves.
function placedPoint(state, p) {
  let pt = p.point;
  const n = p.normal;
  if (p.face && state.bodies.length) {
    const m = matchFace(state, p.face);
    if (m && dot(m.sig.n, n) > 0.999) pt = add(pt, mul(n, dot(sub(m.sig.c, pt), n)));
  }
  return pt;
}

function holeTool(state, f) {
  const p = f.params;
  const n = p.normal;
  if (!p.point || !n) throw new Error('Click a face to place the hole');
  const pt = placedPoint(state, p);
  const dia = Number(p.diameter);
  if (!(dia > 0)) throw new Error('Diameter must be greater than zero');
  if (!state.bodies.length) throw new Error('No body to put a hole in');
  const lead = 0.05;
  const into = mul(n, -1);
  const depth = p.through ? 10000 : Number(p.depth);
  if (!(depth > 0)) throw new Error('Depth must be greater than zero');
  const start = add(pt, mul(n, lead));
  let tool = R.makeCylinder(dia / 2, depth + lead, start, into);
  if (p.kind === 'counterbore') {
    const cbd = Number(p.cbDiameter), cbh = Number(p.cbDepth);
    if (!(cbd > dia) || !(cbh > 0)) throw new Error('Counterbore must be wider than the hole and have a depth');
    tool = tool.fuse(R.makeCylinder(cbd / 2, cbh + lead, start, into));
  }
  return { tool, op: 'cut' };
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function positive(...vals) {
  for (const [label, v] of vals) if (!(Number(v) > 0)) throw new Error(`${label} must be greater than zero`);
}

// Box, cylinder and cone sit on the placement plane and grow along its normal
// (into the part for a cut). Sphere and torus are centred on the point.
function primitiveTool(state, f) {
  const p = f.params;
  if (!p.point || !p.normal) throw new Error('Click a plane or face to place it');
  const placed = placedPoint(state, p);
  const x = p.xDir;
  const flip = (p.flip ? -1 : 1) * (p.op === 'cut' ? -1 : 1);
  const dir = mul(p.normal, flip);
  // A cut starts slightly outside the surface: cutting with a face that lies
  // exactly on the part's face is unreliable in the kernel.
  const lead = p.op === 'cut' && (f.type === 'box' || f.type === 'cylinder' || f.type === 'cone') ? 0.05 : 0;
  const pt = add(placed, mul(dir, -lead));
  const base = new R.Plane(pt, x, dir);
  // Plane through the axis, for revolved profiles: local x = xDir, local y = dir.
  const axial = () => new R.Plane(pt, x, cross(x, dir));
  let tool;
  switch (f.type) {
    case 'box':
      positive(['Width', p.width], ['Depth', p.depth], ['Height', p.height]);
      tool = R.drawRectangle(Number(p.width), Number(p.depth)).sketchOnPlane(base).extrude(Number(p.height) + lead);
      break;
    case 'cylinder':
      positive(['Diameter', p.diameter], ['Height', p.height]);
      tool = R.drawCircle(p.diameter / 2).sketchOnPlane(base).extrude(Number(p.height) + lead);
      break;
    case 'sphere':
      positive(['Diameter', p.diameter]);
      tool = R.makeSphere(p.diameter / 2).translate(placed);
      break;
    case 'torus': {
      positive(['Ring diameter', p.ringDiameter], ['Tube diameter', p.tubeDiameter]);
      const R0 = p.ringDiameter / 2, r = p.tubeDiameter / 2;
      if (r >= R0) throw new Error('Tube diameter must be smaller than the ring diameter');
      tool = R.drawCircle(r).translate(R0, 0).sketchOnPlane(axial()).revolve(dir, { origin: placed });
      break;
    }
    case 'cone': {
      positive(['Bottom diameter', p.bottomDiameter], ['Height', p.height]);
      const r2 = Math.max(0, Number(p.topDiameter) / 2 || 0), h0 = Number(p.height);
      // Keep the same slope over the extra lead length.
      const r1 = p.bottomDiameter / 2 + ((p.bottomDiameter / 2 - r2) / h0) * lead, h = h0 + lead;
      let pen = R.draw([0, 0]).lineTo([r1, 0]);
      pen = r2 > 1e-6 ? pen.lineTo([r2, h]).lineTo([0, h]) : pen.lineTo([0, h]);
      tool = pen.close().sketchOnPlane(axial()).revolve(dir, { origin: pt });
      break;
    }
  }
  return { tool, op: p.op };
}

// ---------- imported STL ----------

const meshData = new Map(); // mesh id -> encoded mesh, sent once by the page
const meshSolids = new Map(); // "id|sx,sy,sz" -> { solid, warning }

// Turn triangles into a solid: sew them into closed shells, make solids, then merge
// triangles that lie in one plane into single faces.
function loadMeshSolid(id, scale) {
  const key = `${id}|${scale.join()}`;
  if (meshSolids.has(key)) return meshSolids.get(key);
  const enc = meshData.get(id);
  if (!enc) throw new Error('The STL data is missing from this project');
  const oc = R.getOC();
  oc.FS.writeFile('/import.stl', meshToSTL(decodeMesh(enc), scale));
  const read = new oc.TopoDS_Shape();
  const ok = new oc.StlAPI_Reader().Read(read, '/import.stl');
  oc.FS.unlink('/import.stl');
  if (!ok) throw new Error('Could not read the STL');
  const sew = new oc.BRepBuilderAPI_Sewing(1e-3, true, true, true, false);
  sew.Add(read);
  sew.Perform();
  const open = sew.NbFreeEdges();
  const sewed = sew.SewedShape();
  const fix = new oc.ShapeFix_Solid();
  const solids = [];
  const ex = new oc.TopExp_Explorer(sewed, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; ex.More(); ex.Next()) solids.push(R.cast(fix.SolidFromShell(oc.TopoDS.Shell(ex.Current()))));
  if (!solids.length) throw new Error('The STL has no closed surface');
  let shape = solids.length === 1 ? solids[0] : R.makeCompound(solids);
  const unify = new oc.ShapeUpgrade_UnifySameDomain(shape.wrapped, true, true, false);
  unify.Build();
  shape = R.cast(R.downcast(unify.Shape()));
  const warning = open ? `The STL has ${open} open edges, so cuts and joins on it may fail` : null;
  const entry = { solid: shape, warning };
  meshSolids.set(key, entry);
  return entry;
}

function stlTool(state, f) {
  const p = f.params;
  const unit = { mm: 1, cm: 10, in: 25.4 }[p.units] || 1;
  const s = [p.sx, p.sy, p.sz].map((v) => unit * Number(v));
  if (!s.every((v) => v > 0)) throw new Error('Scale must be greater than zero');
  const { solid, warning } = loadMeshSolid(p.mesh, s);
  if (warning) state.warnings.push(warning);
  let tool = solid.clone();
  if (p.center) {
    // Centre on the origin in X and Y, and stand it on the XY plane.
    const [min, max] = tool.boundingBox.bounds;
    tool = tool.translate([-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]]);
  }
  return { tool, op: p.op, name: p.name.replace(/\.stl$/i, '') };
}

// Features that add or remove a solid "tool" shape. These can be patterned.
const TOOL_FEATURES = {
  extrude: extrudeTool, revolve: revolveTool, hole: holeTool, loft: loftTool, sweep: sweepTool,
  box: primitiveTool, cylinder: primitiveTool, sphere: primitiveTool, torus: primitiveTool, cone: primitiveTool,
  stl: stlTool,
};

// ---------- move, patterns, mirror ----------

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const MIRROR_NORMALS = { XY: [0, 0, 1], XZ: [0, 1, 0], YZ: [1, 0, 0] };
const MAX_COPIES = 200;

function count(v, label) {
  const n = Math.round(Number(v));
  if (!(n >= 1)) throw new Error(`${label} must be at least 1`);
  return n;
}

// The copies a pattern makes, as functions shape -> new shape (the original is kept).
function patternTransforms(f) {
  const p = f.params;
  const out = [];
  if (f.type === 'rectPattern') {
    const n1 = count(p.count1, 'Count'), n2 = p.dir2 === 'none' ? 1 : count(p.count2, 'Second count');
    const d1 = mul(AXES[p.dir1], Number(p.spacing1) || 0);
    const d2 = p.dir2 === 'none' ? [0, 0, 0] : mul(AXES[p.dir2], Number(p.spacing2) || 0);
    if (n1 * n2 > MAX_COPIES) throw new Error(`Too many copies (limit ${MAX_COPIES})`);
    for (let i = 0; i < n1; i++) {
      for (let j = 0; j < n2; j++) {
        if (i || j) { const v = add(mul(d1, i), mul(d2, j)); out.push((s) => s.clone().translate(v)); }
      }
    }
  } else if (f.type === 'circPattern') {
    const n = count(p.count, 'Count');
    if (n > MAX_COPIES) throw new Error(`Too many copies (limit ${MAX_COPIES})`);
    const total = Number(p.angle) || 360;
    const step = Math.abs(total) >= 360 ? 360 / n : total / Math.max(1, n - 1);
    const center = [p.cx, p.cy, p.cz].map(Number);
    for (let k = 1; k < n; k++) out.push((s) => s.clone().rotate(step * k, center, AXES[p.axis]));
  } else if (f.type === 'mirror') {
    const nrm = MIRROR_NORMALS[p.plane];
    const origin = mul(nrm, Number(p.offset) || 0);
    out.push((s) => s.clone().mirror(nrm, origin));
  }
  return out;
}

function selectedBodies(state, ids) {
  const sel = state.bodies.filter((b) => (ids || []).includes(b.id));
  if (!sel.length) throw new Error('Select at least one body');
  return sel;
}

function addBody(state, id, shape) {
  state.bodyCount += 1;
  state.bodies = [...state.bodies, { id, name: `Body${state.bodyCount}`, shape }];
}

function pattern(state, f) {
  const p = f.params;
  const xf = patternTransforms(f);
  if (p.mode === 'features') {
    if (!p.features?.length) throw new Error('Select at least one feature');
    for (const id of p.features) {
      const src = state.featureById.get(id);
      if (!src || src.suppressed || !TOOL_FEATURES[src.type]) throw new Error('A selected feature is missing or suppressed');
      // The tool is rebuilt in the current state, so it follows earlier edits.
      const { tool, op } = TOOL_FEATURES[src.type](state, src);
      xf.forEach((t, k) => applyBodyOp(state, `${f.id}#${id}#${k}`, t(tool), op));
    }
  } else {
    for (const b of selectedBodies(state, p.bodies)) {
      xf.forEach((t, k) => addBody(state, `${f.id}#${b.id}#${k}`, t(b.shape)));
    }
  }
}

// Rotate about the pivot, then translate. With "copy", the originals stay.
function move(state, f) {
  const p = f.params;
  if (p.mode === 'faces') { moveFaces(state, f); return; }
  const sel = selectedBodies(state, p.bodies);
  const angle = Number(p.angle) || 0;
  const v = [p.dx, p.dy, p.dz].map((x) => Number(x) || 0);
  const pivot = p.pivot || [0, 0, 0];
  const t = (s) => {
    let r = s.clone();
    if (angle) r = r.rotate(angle, pivot, AXES[p.axis] || AXES.z);
    if (v.some((x) => x)) r = r.translate(v);
    return r;
  };
  if (p.copy) {
    sel.forEach((b) => addBody(state, `${f.id}#${b.id}`, t(b.shape)));
  } else {
    const ids = new Set(sel.map((b) => b.id));
    state.bodies = state.bodies.map((b) => (ids.has(b.id) ? { ...b, shape: t(b.shape) } : b));
  }
}

// Combine: join, cut or intersect tool bodies into a target body. Tools are used up
// unless "keep" is set.
function combine(state, f) {
  const p = f.params;
  const target = state.bodies.find((b) => b.id === p.target);
  if (!target) throw new Error('Pick the target body');
  const tools = state.bodies.filter((b) => (p.tools || []).includes(b.id) && b.id !== p.target);
  if (!tools.length) throw new Error('Pick at least one tool body');
  let shape = target.shape;
  for (const t of tools) {
    if (p.op === 'cut') shape = shape.cut(t.shape);
    else if (p.op === 'intersect') shape = shape.intersect(t.shape);
    else shape = shape.fuse(t.shape);
  }
  if (p.op !== 'join' && !shape.faces.length) {
    throw new Error(p.op === 'cut' ? 'The tools remove the whole target' : "The bodies don't overlap");
  }
  const used = new Set(tools.map((t) => t.id));
  state.bodies = state.bodies
    .filter((b) => p.keep || !used.has(b.id))
    .map((b) => (b.id === target.id ? { ...b, shape } : b));
}

// Uniform scale about the centre of the selected bodies, or the origin.
function scaleBodies(state, f) {
  const p = f.params;
  const k = Number(p.factor);
  if (!(k > 0)) throw new Error('Scale must be greater than zero');
  const sel = new Set(selectedBodies(state, p.bodies).map((b) => b.id));
  const c = p.about === 'origin' ? [0, 0, 0] : p.pivot || [0, 0, 0];
  state.bodies = state.bodies.map((b) => (sel.has(b.id) ? { ...b, shape: b.shape.clone().scale(k, c) } : b));
}

// Split Body: cut bodies in two with a plane (a picked origin plane or face, moved along
// its normal by the offset). With no bodies picked, every body the plane crosses is split.
// The half on the arrow side becomes a new body, unless only one side is kept.
function split(state, f) {
  const p = f.params;
  const n = p.normal;
  if (!n) throw new Error('Click an origin plane or a flat face');
  const o = add(placedPoint(state, p), mul(n, Number(p.offset) || 0));
  // Signed distances of a body's bounding box corners from the plane.
  const sides = (b) => {
    const [min, max] = b.shape.boundingBox.bounds;
    const d = [];
    for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) d.push(dot(sub([x, y, z], o), n));
    return [Math.min(...d), Math.max(...d)];
  };
  const crosses = (b) => { const [lo, hi] = sides(b); return lo < -1e-6 && hi > 1e-6; };
  let targets;
  if (p.bodies?.length) {
    targets = selectedBodies(state, p.bodies);
    const miss = targets.find((b) => !crosses(b));
    if (miss) throw new Error(`The plane doesn't cut ${miss.name}`);
  } else {
    targets = state.bodies.filter(crosses);
    if (!targets.length) throw new Error("The plane doesn't pass through any body");
  }
  const x0 = Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]);
  const xDir = mul(x0, 1 / len(x0)), yDir = cross(n, xDir);
  const ids = new Set(targets.map((b) => b.id));
  const halves = [];
  state.bodies = state.bodies.flatMap((b) => {
    if (!ids.has(b.id)) return [b];
    // A block on the arrow side of the plane, centred on the body and big enough to cover it.
    const [min, max] = b.shape.boundingBox.bounds;
    const c = sub(mul(add(min, max), 0.5), o);
    const s = 2 * len(sub(max, min)) + 10;
    const block = R.drawRectangle(s, s).translate(dot(c, xDir), dot(c, yDir))
      .sketchOnPlane(new R.Plane(o, xDir, n)).extrude(sides(b)[1] + 10);
    const front = b.shape.intersect(block), back = b.shape.cut(block);
    if (p.keep === 'front') return [{ ...b, shape: front }];
    if (p.keep === 'back') return [{ ...b, shape: back }];
    halves.push([`${f.id}#${b.id}`, front]);
    return [{ ...b, shape: back }];
  });
  for (const [id, shape] of halves) addBody(state, id, shape);
}

// Remove: drop bodies from the model from this step on.
function removeBodies(state, f) {
  const ids = new Set(selectedBodies(state, f.params.bodies).map((b) => b.id));
  state.bodies = state.bodies.filter((b) => !ids.has(b.id));
}

function runFeature(state, f) {
  const p = f.params;
  switch (f.type) {
    case 'sketch': state.sketches.set(f.id, p); break;
    case 'move': move(state, f); break;
    case 'scale': scaleBodies(state, f); break;
    case 'combine': combine(state, f); break;
    case 'remove': removeBodies(state, f); break;
    case 'split': split(state, f); break;
    case 'thread': thread(state, f); break;
    case 'rectPattern': case 'circPattern': case 'mirror': pattern(state, f); break;
    case 'fillet': edgeFeature(state, f, 'fillet', Number(p.radius)); break;
    case 'chamfer': edgeFeature(state, f, 'chamfer', Number(p.distance)); break;
    case 'shell': shell(state, f); break;
    case 'pressPull': pressPull(state, f); break;
    default: {
      if (!TOOL_FEATURES[f.type]) throw new Error(`Unknown feature ${f.type}`);
      const { tool, op, name } = TOOL_FEATURES[f.type](state, f);
      applyBodyOp(state, f.id, tool, op, name);
    }
  }
}

// ---------- meshing ----------

// `withEdges` adds edge lines; `withVolume` measures volume (skipped while dragging).
function meshBodies(bodies, opts, withEdges, withVolume = withEdges) {
  const transfer = [];
  const out = bodies.map((b) => {
    const m = b.shape.mesh(opts);
    const res = {
      id: b.id,
      name: b.name,
      vertices: new Float32Array(m.vertices),
      normals: new Float32Array(m.normals),
      triangles: new Uint32Array(m.triangles),
      faceGroups: m.faceGroups,
    };
    transfer.push(res.vertices.buffer, res.normals.buffer, res.triangles.buffer);
    if (withEdges) {
      const em = b.shape.meshEdges(opts);
      const dense = em.edgeGroups.length > MAX_EDGE_LINES;
      res.lines = new Float32Array(dense ? [] : em.lines);
      res.edgeGroups = dense ? [] : em.edgeGroups;
      transfer.push(res.lines.buffer);
    }
    if (withVolume) {
      try { res.volume = R.measureVolume(b.shape); } catch { res.volume = null; }
    }
    return res;
  });
  return { out, transfer };
}

// ---------- building ----------

// Features never change a body in place (they make new body objects), so a copy of
// the lists is enough to run more features without touching the original.
const copyState = (s) => ({
  ...s, bodies: [...s.bodies], sketches: new Map(s.sketches), featureById: new Map(s.featureById), warnings: [],
});

// The state after the last build. A new build whose feature list starts with the same
// features carries on from here, so steps before the one being edited aren't rerun.
let checkpoint = null; // { keys, state, errors, warnings, key }
let checkpointCount = 0;

function replay(feats) {
  const keys = feats.map((f) => JSON.stringify(f));
  const cp = checkpoint;
  const reuse = cp && cp.keys.length <= keys.length && cp.keys.every((k, i) => k === keys[i]);
  if (reuse && cp.keys.length === keys.length) return { ...cp, state: copyState(cp.state) };
  const state = reuse ? copyState(cp.state) : { bodies: [], sketches: new Map(), featureById: new Map(), bodyCount: 0, warnings: [] };
  const errors = reuse ? { ...cp.errors } : {};
  const warnings = reuse ? { ...cp.warnings } : {};
  for (const f of feats.slice(reuse ? cp.keys.length : 0)) {
    state.featureById.set(f.id, f);
    if (f.suppressed) continue;
    state.warnings = [];
    try { runFeature(state, f); tidyBodies(state); }
    catch (e) { errors[f.id] = errText(e); }
    if (state.warnings.length) warnings[f.id] = state.warnings[0];
  }
  // `key` names this exact model, so the page can tell whether it already has its meshes.
  checkpoint = { keys, state: copyState(state), errors, warnings, key: String(++checkpointCount) };
  return { ...checkpoint, state };
}

// msg: { features, stopAt?, draft?, export?, fast?, haveBase? }. When `haveBase` names the
// model the page already shows, its meshes aren't sent again. In the draft's preview,
// bodies the draft didn't change come back as { id, same: true }.
function build(msg) {
  for (const [id, enc] of Object.entries(msg.meshes || {})) meshData.set(id, enc);
  const feats = msg.stopAt == null ? msg.features : msg.features.slice(0, msg.stopAt);
  const { state, errors, warnings, key } = replay(feats);

  const opts = msg.export ? EXPORT_MESH : DISPLAY_MESH;
  const transfer = [];
  let bodies = null;
  if (msg.export || msg.haveBase !== key) {
    const base = meshBodies(state.bodies, opts, !msg.export);
    bodies = base.out;
    transfer.push(...base.transfer);
  }

  let preview = null, draftError = null, draftNote = null;
  if (msg.draft) {
    const snapshot = copyState(state);
    snapshot.note = null; // only the step being edited reports a note
    try {
      runFeature(snapshot, msg.draft);
      draftNote = snapshot.note || null;
      tidyBodies(snapshot);
      const before = new Set(state.bodies);
      const changed = snapshot.bodies.filter((b) => !before.has(b));
      // While dragging, skip edge lines; the preview's volume is never shown.
      const pm = meshBodies(changed, opts, !msg.fast, false);
      const meshed = new Map(changed.map((b, i) => [b, pm.out[i]]));
      preview = snapshot.bodies.map((b) => meshed.get(b) || { id: b.id, same: true });
      transfer.push(...pm.transfer);
    } catch (e) { draftError = errText(e); }
  }
  self.postMessage({ type: 'built', id: msg.id, baseKey: key, bodies, preview, errors, warnings, draftError, draftNote }, transfer);
}

function errText(e) {
  if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.Exception) {
    return 'The geometry kernel could not build this. Try a smaller size, or check the selection.';
  }
  // The kernel's wording when an operation comes back empty.
  if (/has not type, it is null/.test(e?.message)) return 'This step leaves nothing behind. Try smaller sizes, for example thinner walls.';
  return e?.message || String(e);
}

// ---------- startup ----------

try {
  const OC = await opencascade({ locateFile: () => WASM_URL });
  R.setOC(OC);
  self.onmessage = (ev) => {
    const msg = ev.data;
    try {
      if (msg.type === 'build') build(msg);
    } catch (e) {
      self.postMessage({ type: 'failed', id: msg.id, error: errText(e) });
    }
  };
  self.postMessage({ type: 'ready' });
} catch (e) {
  self.postMessage({ type: 'init-error', error: e?.message || String(e) });
}
