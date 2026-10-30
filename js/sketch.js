// Sketch mode: draw lines, rectangles, circles and arcs on a plane, constrain and
// dimension them, and drag them while the constraint solver keeps everything valid.
// Produces the `params` of a sketch feature (see sketch-model.js).

import { planeFrame, sketchFrame, dist2, circleFrom3, PLANES, toWorld } from './profiles.js';
import { el, field, num } from './ui.js';
import * as M from './sketch-model.js';
import { solve, analyse, dragTargets, dragRadius, loadSolver } from './solver.js';
import * as T from './sketch-tools.js';
import { SketchLabels } from './sketch-labels.js';

const TOOLS = {
  line: { label: 'Line', hint: 'Click points to draw lines. Click the first point to close. Esc ends the chain.' },
  rect: { label: '2-Point Rectangle', hint: 'Click two opposite corners. Type width and height, then Enter.' },
  crect: { label: 'Center Rectangle', hint: 'Click the center, then a corner. Type width and height, then Enter.' },
  circle: { label: 'Center Diameter Circle', hint: 'Click the center, then a point on the circle. Type a diameter, then Enter.' },
  arc: { label: '3-Point Arc', hint: 'Click the start, the end, then a point on the arc.' },
  polygon: { label: 'Polygon', hint: 'Click the centre, then a corner. Set the number of sides in the panel.' },
  slot: { label: 'Slot', hint: 'Click the centre of one end, the centre of the other end, then the width.' },
  fillet: { label: 'Fillet', hint: 'Click corners where two lines meet to round them. Set the radius in the panel.' },
  trim: { label: 'Trim', hint: 'Click the part of a curve to cut away, up to where other curves cross it.' },
  project: { label: 'Project', hint: 'Click body edges to bring them into the sketch as fixed geometry.' },
  select: { label: 'Select', hint: 'Click to select (Shift or Ctrl adds), drag to move. Then pick a constraint, or press Delete.' },
  dimension: { label: 'Dimension', hint: 'Click a line, circle or arc, or two points, or two lines (angle). Type the value and press Enter.' },
};

// Tools that click on existing things, not empty space.
const PICK_TOOLS = new Set(['select', 'dimension', 'fillet', 'trim', 'project']);

const COLOR = { free: 0x1f6fd6, fixed: 0x1d2329, select: 0x0a6cff, hover: 0x6fb6ff, construction: 0xe08a1e };

const r3 = (v) => Math.round(v * 1000) / 1000;
const rp = (p) => [r3(p[0]), r3(p[1])];
const fmt = (v) => String(Math.round(v * 100) / 100);

export class SketchMode {
  constructor(app, { params, onFinish, onCancel }) {
    this.app = app;
    this.vp = app.vp;
    this.params = M.migrate(structuredClone(params));
    this.onFinish = onFinish;
    this.onCancel = onCancel;
    this.tool = 'line';
    this.pts = [];          // clicked positions for the current tool: [{ uv, id? }]
    this.cursor = null;     // snapped cursor: { uv, id?, origin?, onCurve? }
    this.snapInfo = null;
    this.selected = new Set(); // point, curve and constraint ids
    this.hover = null;
    this.grid = 1;
    this.settings = { sides: 6, fillet: 2, offset: 2 };
    this.undoStack = [];
    this.redoStack = [];
    this.info = { dof: null, fixed: new Set() };
    this.frame = sketchFrame(this.params);
    this.dimBox = document.getElementById('dim-box');
  }

  start() {
    this.vp.tool = this;
    this.labels = new SketchLabels(this.vp, {
      onClick: (id, e) => this.clickConstraint(id, e),
      onDblClick: (id, node) => this.editDimension(id, node),
    });
    this.lookAt();
    this.setTool(this.params.curves.length ? 'select' : 'line');
    this.keyHandler = (e) => this.onKey(e);
    window.addEventListener('keydown', this.keyHandler);
    loadSolver().then(() => this.changed());
    this.changed();
  }

  stop() {
    window.removeEventListener('keydown', this.keyHandler);
    this.hideDim();
    this.labels?.dispose();
    this.vp.tool = null;
    this.vp.setOverlay([]);
  }

  lookAt() {
    const n = this.frame.normal;
    this.vp.setView(n.map((v) => -v), this.frame.yDir);
  }

  setTool(t) {
    this.tool = t;
    this.pts = [];
    this.dimPick = null;
    this.hideDim();
    M.pruneConstraints(this.params);
    document.querySelectorAll('[data-sketch-tool]').forEach((b) => b.classList.toggle('active', b.dataset.sketchTool === t));
    this.app.setStatus(TOOLS[t].hint);
    this.changed();
  }

  // ---------- history ----------

  snapshot() { const { entities, ...rest } = this.params; return structuredClone(rest); }

  pushUndo(snap = this.snapshot()) {
    this.undoStack.push(snap);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  // Step back (undo) or forward (redo) through the sketch's own history.
  restore(from, to) {
    const snap = from.pop();
    if (!snap) return;
    to.push(this.snapshot());
    this.params = { ...snap, entities: [] };
    this.selected.clear();
    this.pts = [];
    this.changed();
  }

  // After any change: rebuild the flat entities, re-check what is fully fixed, redraw.
  changed({ check = true } = {}) {
    this.params.entities = M.toEntities(this.params);
    if (check) this.info = analyse(this.params);
    this.refresh();
    this.renderPanel();
  }

  // Apply an edit; if the solver can't satisfy the result, undo it and say why.
  edit(fn, { newIds = [] } = {}) {
    const before = this.snapshot();
    try {
      fn();
    } catch (e) {
      this.params = { ...before, entities: [] };
      this.app.setStatus(e.message, 'warn');
      this.changed();
      return false;
    }
    const res = solve(this.params);
    const clash = !res.ok || newIds.some((id) => res.redundant?.includes(id));
    if (clash) {
      this.params = { ...before, entities: [] };
      this.app.setStatus(res.ok ? 'That is already determined by other constraints.' : 'That conflicts with the existing constraints.', 'warn');
      this.changed();
      return false;
    }
    this.pushUndo(before);
    this.changed();
    return true;
  }

  // ---------- snapping ----------

  snap(ev) {
    const raw = this.vp.planeHit(ev, this.frame);
    if (!raw) return null;
    const sk = this.params;
    const tol = this.vp.unitsPerPixel() * 9;
    const hit = M.hitTest(sk, raw, tol, { curves: false });
    if (hit) { this.snapInfo = 'point'; return { uv: M.xy(sk, hit.id), id: hit.id }; }
    if (Math.hypot(raw[0], raw[1]) < tol) { this.snapInfo = 'point'; return { uv: [0, 0], origin: true }; }
    // Onto a curve: the new point will stay on it.
    const onCurve = M.hitTest(sk, raw, tol * 0.7, { points: false });
    if (onCurve) {
      const c = M.curveById(sk, onCurve.id);
      this.snapInfo = 'curve';
      return { uv: rp(projectOnto(sk, c, raw)), onCurve: c.id };
    }
    this.snapInfo = null;
    let p = this.grid > 0 ? raw.map((v) => Math.round(v / this.grid) * this.grid) : raw;
    const prev = this.pts[this.pts.length - 1]?.uv;
    if (prev && this.tool === 'line') {
      if (Math.abs(raw[1] - prev[1]) < tol) { p = [p[0], prev[1]]; this.snapInfo = 'horizontal'; }
      else if (Math.abs(raw[0] - prev[0]) < tol) { p = [prev[0], p[1]]; this.snapInfo = 'vertical'; }
    }
    return { uv: rp(p) };
  }

  // A sketch point for a snapped position: reuse a snapped point, or make one (on the
  // origin it is fixed; on a curve it is constrained to stay on it).
  pointFor(s) {
    const sk = this.params;
    if (s.id) return s.id;
    const id = M.addPoint(sk, s.uv);
    if (s.origin) M.addConstraint(sk, 'fix', [id]);
    if (s.onCurve) M.addConstraint(sk, 'onCurve', [id, s.onCurve]);
    return id;
  }

  // ---------- pointer ----------

  pickAt(ev) {
    const uv = this.vp.planeHit(ev, this.frame);
    return uv && M.hitTest(this.params, uv, this.vp.unitsPerPixel() * 8);
  }

  onMove(ev) {
    this.lastEv = ev;
    if (PICK_TOOLS.has(this.tool)) {
      if (this.tool === 'project') this.hover = this.vp.pick(ev, { edges: true });
      else {
        const uv = this.vp.planeHit(ev, this.frame);
        const only = this.tool === 'fillet' ? { curves: false } : this.tool === 'trim' ? { points: false } : {};
        this.hover = uv && M.hitTest(this.params, uv, this.vp.unitsPerPixel() * 8, only);
      }
      this.refreshOverlay();
      return;
    }
    this.cursor = this.snap(ev);
    this.updateDim();
    this.refreshOverlay();
  }

  onLeave() { this.cursor = null; this.hover = null; this.refreshOverlay(); }

  // Select tool: press on a point or curve to drag it (a click without moving selects it).
  onPointerDown(ev) {
    if (this.tool !== 'select') return false;
    const hit = this.pickAt(ev);
    if (!hit) return false;
    this.drag = { hit, uv0: this.vp.planeHit(ev, this.frame), snap: this.snapshot(), moved: false, x: ev.clientX, y: ev.clientY };
    return true;
  }

  onDrag(ev) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < 4) return;
    d.moved = true;
    const uv = this.vp.planeHit(ev, this.frame);
    if (!uv) return;
    const sk = this.params;
    const base = { ...d.snap, entities: [] };
    const delta = [uv[0] - d.uv0[0], uv[1] - d.uv0[1]];
    // Start each step from where the drag began, so the motion doesn't drift.
    this.params = structuredClone(base);
    let extra;
    if (d.hit.kind === 'point') extra = dragTargets({ [d.hit.id]: uv });
    else {
      const c = M.curveById(this.params, d.hit.id);
      if (c.t === 'circle') extra = dragRadius(c.id, Math.max(0.01, dist2(M.xy(this.params, c.c), uv)));
      else {
        const targets = {};
        for (const p of M.curvePoints(c)) { const q = M.xy(this.params, p); targets[p] = [q[0] + delta[0], q[1] + delta[1]]; }
        extra = dragTargets(targets);
      }
    }
    if (!solve(this.params, extra).ok) this.params = sk;
    this.changed({ check: false });
  }

  onDragEnd(ev) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (!d.moved) { this.selectItem(d.hit.id, ev); return; }
    solve(this.params);
    this.pushUndo(d.snap);
    this.changed();
  }

  selectItem(id, ev) {
    const add = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    if (!add) { const had = this.selected.has(id) && this.selected.size === 1; this.selected.clear(); if (had) { this.changed({ check: false }); return; } }
    if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
    this.changed({ check: false });
  }

  clickConstraint(id, ev) { this.selectItem(id, ev); }

  onClick(ev) {
    if (this.tool === 'select') {
      if (!(ev.shiftKey || ev.ctrlKey || ev.metaKey)) { this.selected.clear(); this.changed({ check: false }); }
      return;
    }
    if (this.tool === 'dimension') { this.dimensionClick(ev); return; }
    if (this.tool === 'fillet' || this.tool === 'trim' || this.tool === 'project') { this.toolClick(ev); return; }
    const s = this.snap(ev);
    if (s) this.place(s);
  }

  onDblClick() { if (this.tool === 'line') this.endChain(); }

  // Fillet, Trim and Project act on what is clicked.
  toolClick(ev) {
    const sk = this.params;
    if (this.tool === 'project') {
      const hit = this.vp.pick(ev, { edges: true });
      if (hit?.kind === 'edge') this.edit(() => T.projectEdge(sk, this.frame, hit.points));
      return;
    }
    const uv = this.vp.planeHit(ev, this.frame);
    if (!uv) return;
    const tol = this.vp.unitsPerPixel() * 8;
    if (this.tool === 'fillet') {
      const hit = M.hitTest(sk, uv, tol, { curves: false });
      if (hit) this.edit(() => T.filletCorner(sk, hit.id, this.settings.fillet));
    } else {
      const hit = M.hitTest(sk, uv, tol, { points: false });
      if (hit) this.edit(() => T.trimAt(sk, hit.id, uv));
    }
    this.hover = null;
  }

  offsetSelected() {
    const ids = this.selection().curves.map((c) => c.id);
    if (!ids.length) { this.app.setStatus('Select the curves to offset (one chain, or a circle), then click Offset.', 'warn'); return; }
    if (this.edit(() => T.offsetCurves(this.params, ids, this.settings.offset))) this.selected.clear();
    this.changed({ check: false });
  }

  place(s) {
    const sk = this.params;
    const pts = this.pts;
    switch (this.tool) {
      case 'line': {
        const prev = pts[pts.length - 1];
        if (prev && dist2(prev.uv, s.uv) < 1e-9) return;
        const snapInfo = this.snapInfo;
        let id = null;
        const ok = this.edit(() => {
          id = this.pointFor(s);
          if (prev) {
            const line = M.newId(sk, 'c');
            sk.curves.push({ id: line, t: 'line', p1: prev.id, p2: id });
            if (snapInfo === 'horizontal' || snapInfo === 'vertical') M.addConstraint(sk, snapInfo, [line]);
            if (s.typed) M.addConstraint(sk, 'length', [line], s.typed[0]);
          }
        });
        if (!ok) return;
        pts.push({ uv: M.xy(this.params, id), id });
        if (pts.length > 2 && id === pts[0].id) this.endChain();
        break;
      }
      case 'rect':
      case 'crect':
      case 'circle':
        if (!pts.length) { pts.push(s); break; }
        this.finishShape(s);
        break;
      case 'polygon':
        if (!pts.length) { pts.push(s); break; }
        this.edit(() => T.addPolygon(sk, this.pointFor(pts[0]), s.uv, this.settings.sides));
        this.pts = [];
        break;
      case 'slot':
        if (pts.length < 2) { pts.push(s); break; }
        this.edit(() => T.addSlot(sk, this.pointFor(pts[0]), this.pointFor(pts[1]), 2 * distToLine(s.uv, pts[0].uv, pts[1].uv)));
        this.pts = [];
        break;
      case 'arc':
        pts.push(s);
        if (pts.length === 3) {
          const [a, b, m] = pts;
          if (circleFrom3(a.uv, m.uv, b.uv)) this.edit(() => M.addArc3(sk, this.pointFor(a), this.pointFor(b), m.uv));
          this.pts = [];
        }
        break;
    }
    this.updateDim();
    this.refresh();
  }

  // Rectangles become four lines with horizontal/vertical constraints, as in Fusion.
  finishShape(s) {
    const sk = this.params;
    const a = this.pts[0];
    if (dist2(a.uv, s.uv) < 1e-9) return;
    this.edit(() => {
      if (this.tool === 'circle') {
        const id = M.newId(sk, 'c');
        sk.curves.push({ id, t: 'circle', c: this.pointFor(a), r: r3(dist2(a.uv, s.uv)) });
        if (s.typed) M.addConstraint(sk, 'diameter', [id], s.typed[0]);
        return;
      }
      const centre = this.tool === 'crect';
      const c0 = centre ? M.addPoint(sk, rp([2 * a.uv[0] - s.uv[0], 2 * a.uv[1] - s.uv[1]])) : this.pointFor(a);
      const c2 = this.pointFor(s);
      const [x0, y0] = M.xy(sk, c0), [x2, y2] = M.xy(sk, c2);
      const c1 = M.addPoint(sk, [x2, y0]), c3 = M.addPoint(sk, [x0, y2]);
      const ring = [c0, c1, c2, c3];
      const lines = ring.map((p, i) => { const id = M.newId(sk, 'c'); sk.curves.push({ id, t: 'line', p1: p, p2: ring[(i + 1) % 4] }); return id; });
      lines.forEach((id, i) => M.addConstraint(sk, i % 2 ? 'vertical' : 'horizontal', [id]));
      if (s.typed) { M.addConstraint(sk, 'length', [lines[0]], s.typed[0]); M.addConstraint(sk, 'length', [lines[1]], s.typed[1]); }
    });
    this.pts = [];
    this.hideDim();
    this.refresh();
  }

  endChain() {
    this.pts = [];
    this.hideDim();
    M.pruneConstraints(this.params);
    this.changed();
  }

  // ---------- constraints ----------

  selection() {
    const sk = this.params;
    const points = [], curves = [];
    for (const id of this.selected) {
      if (M.pointById(sk, id)) points.push(id);
      else { const c = M.curveById(sk, id); if (c) curves.push(c); }
    }
    return { points, curves, lines: curves.filter((c) => c.t === 'line'), rounds: curves.filter((c) => c.t !== 'line') };
  }

  // Apply a constraint to the current selection (Fusion style: select first, then constrain).
  applyConstraint(type) {
    const sk = this.params;
    const { points, curves, lines, rounds } = this.selection();
    const def = M.CONSTRAINTS[type];
    const add = [];   // [type, refs]
    let merge = null; // [keep, remove] point pairs
    if (type === 'coincident') {
      if (points.length === 2 && !curves.length) merge = [[points[0], points[1]]];
      else if (points.length === 1 && curves.length === 1) add.push(['onCurve', [points[0], curves[0].id]]);
    } else if (type === 'horizontal' || type === 'vertical') {
      if (lines.length && !points.length) lines.forEach((l) => add.push([type, [l.id]]));
      else if (points.length === 2 && !curves.length) add.push([type, points]);
    } else if (type === 'parallel' || type === 'equal') {
      const group = type === 'equal' && rounds.length >= 2 && !lines.length ? rounds : lines.length >= 2 && !rounds.length ? lines : [];
      group.slice(1).forEach((c) => add.push([type, [group[0].id, c.id]]));
    } else if (type === 'perpendicular') {
      if (lines.length === 2 && curves.length === 2) add.push([type, [lines[0].id, lines[1].id]]);
    } else if (type === 'tangent') {
      if (curves.length === 2 && rounds.length >= 1) add.push([type, [curves[0].id, curves[1].id]]);
    } else if (type === 'concentric') {
      if (rounds.length === 2 && curves.length === 2) merge = [[rounds[0].c, rounds[1].c]];
    } else if (type === 'midpoint') {
      if (points.length === 1 && lines.length === 1 && curves.length === 1) add.push([type, [points[0], lines[0].id]]);
    } else if (type === 'fix') {
      if (points.length || curves.length) add.push(['fix', [...points, ...curves.map((c) => c.id)]]);
    }
    if (!add.length && !merge) { this.app.setStatus(`${def.label} needs ${def.needs} selected.`, 'warn'); return; }
    const newIds = [];
    const ok = this.edit(() => {
      merge?.forEach(([a, b]) => M.mergePoints(sk, a, b));
      add.forEach(([t, refs]) => newIds.push(M.addConstraint(sk, t, refs).id));
    }, { newIds });
    if (ok) { this.selected.clear(); this.app.setStatus(`${def.label} added.`); this.changed({ check: false }); }
  }

  toggleConstruction() {
    const { curves } = this.selection();
    if (!curves.length) { this.app.setStatus('Select curves to turn into construction lines (or back).', 'warn'); return; }
    this.edit(() => curves.forEach((c) => { c.construction = !c.construction; }));
  }

  deleteSelected() {
    if (!this.selected.size) return;
    const ids = [...this.selected];
    this.selected.clear();
    this.edit(() => M.deleteItems(this.params, ids));
  }

  // ---------- dimensions ----------

  dimensionClick(ev) {
    const sk = this.params;
    const hit = this.pickAt(ev);
    const first = this.dimPick;
    const curve = (h) => h?.kind === 'curve' && M.curveById(sk, h.id);
    if (!first) {
      const c = curve(hit);
      if (c && c.t !== 'line') { this.addDimension(c.t === 'circle' ? 'diameter' : 'radius', [c.id], ev); return; }
      if (hit) { this.dimPick = hit; this.app.setStatus(hit.kind === 'point' ? 'Click a second point, or a line.' : 'Click another line for an angle, a point for a distance, or empty space for the length.'); }
      this.refreshOverlay();
      return;
    }
    this.dimPick = null;
    const a = curve(first), b = curve(hit);
    if (first.kind === 'point' && hit?.kind === 'point' && hit.id !== first.id) this.addDimension('distance', [first.id, hit.id], ev);
    else if (first.kind === 'point' && b?.t === 'line') this.addDimension('pointLine', [first.id, b.id], ev);
    else if (a?.t === 'line' && hit?.kind === 'point') this.addDimension('pointLine', [hit.id, a.id], ev);
    else if (a?.t === 'line' && b?.t === 'line' && b.id !== a.id) {
      const ang = M.lineAngle(sk, a, b);
      this.addDimension('angle', [a.id, b.id], ev, { sign: Math.sign(ang) || 1 });
    } else if (a?.t === 'line') this.addDimension('length', [a.id], ev);
    else this.app.setStatus(TOOLS.dimension.hint);
    this.refreshOverlay();
  }

  // Add a dimension at its current value, then let the user type the value they want.
  addDimension(type, refs, ev, extra = {}) {
    const sk = this.params;
    const k = { id: M.newId(sk, 'k'), type, refs, ...extra };
    k.value = r3(M.measure(sk, k));
    const ok = this.edit(() => sk.constraints.push(k), { newIds: [k.id] });
    if (ok) this.editDimension(k.id, null, ev);
  }

  // Type a new value for a dimension, in a box at its label (or at the mouse).
  editDimension(id, node, ev) {
    const k = this.params.constraints.find((x) => x.id === id);
    if (!k || !M.DIMENSIONS.has(k.type)) return;
    const box = this.dimBox;
    box.innerHTML = '';
    delete box.dataset.tool;
    const inp = el('input', { type: 'text', value: fmt(k.value) });
    box.append(el('label', {}, k.type === 'angle' ? '°' : k.type === 'diameter' ? 'Ø' : k.type === 'radius' ? 'R' : 'mm', inp));
    const r = this.vp.el.getBoundingClientRect();
    const at = node ? node.getBoundingClientRect() : { left: ev.clientX, top: ev.clientY };
    box.style.left = `${at.left - r.left + 12}px`;
    box.style.top = `${at.top - r.top + 12}px`;
    box.hidden = false;
    inp.focus();
    inp.select();
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { this.hideDim(); return; }
      if (e.key !== 'Enter') return;
      const v = num(inp.value);
      if (!(v > 0) && !(k.type === 'angle' && v === 0)) { this.app.setStatus('Enter a number greater than zero.', 'warn'); return; }
      this.hideDim();
      if (this.edit(() => { this.params.constraints.find((x) => x.id === id).value = v; })) this.app.setStatus(TOOLS[this.tool].hint);
    });
  }

  // ---------- typed sizes while drawing ----------

  dimFields() {
    const a = this.pts[0]?.uv, c = this.cursor?.uv;
    if (!a || !c) return null;
    switch (this.tool) {
      case 'line': return [['Length', dist2(this.pts[this.pts.length - 1].uv, c)]];
      case 'rect': return [['W', Math.abs(c[0] - a[0])], ['H', Math.abs(c[1] - a[1])]];
      case 'crect': return [['W', 2 * Math.abs(c[0] - a[0])], ['H', 2 * Math.abs(c[1] - a[1])]];
      case 'circle': return [['Ø', 2 * dist2(a, c)]];
    }
    return null;
  }

  updateDim() {
    const fields = this.dimFields();
    if (!fields || !this.lastEv) { this.hideDim(); return; }
    const box = this.dimBox;
    if (box.dataset.tool !== this.tool || box.children.length !== fields.length) {
      box.innerHTML = '';
      box.dataset.tool = this.tool;
      fields.forEach(([label]) => {
        const inp = el('input', { type: 'text', title: label, placeholder: label });
        inp.addEventListener('keydown', (e) => this.onDimKey(e));
        box.append(el('label', {}, label, inp));
      });
    }
    const inputs = [...box.querySelectorAll('input')];
    fields.forEach(([, v], i) => { if (document.activeElement !== inputs[i] && !inputs[i].dataset.typed) inputs[i].value = v.toFixed(2); });
    const r = this.vp.el.getBoundingClientRect();
    box.style.left = `${this.lastEv.clientX - r.left + 18}px`;
    box.style.top = `${this.lastEv.clientY - r.top + 18}px`;
    box.hidden = false;
  }

  hideDim() {
    if (!this.dimBox) return;
    this.dimBox.hidden = true;
    this.dimBox.innerHTML = '';
    delete this.dimBox.dataset.tool;
  }

  // Typed sizes place the shape and become dimensions on it.
  onDimKey(e) {
    e.stopPropagation();
    e.target.dataset.typed = '1';
    if (e.key === 'Escape') { this.vp.renderer.domElement.focus(); this.setTool(this.tool); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const vals = [...this.dimBox.querySelectorAll('input')].map((i) => num(i.value));
    const a = this.pts[0].uv, c = this.cursor?.uv || a;
    if (vals.some((v) => !(v > 0))) { this.app.setStatus('Enter a number greater than zero.', 'warn'); return; }
    const sx = Math.sign(c[0] - a[0]) || 1, sy = Math.sign(c[1] - a[1]) || 1;
    switch (this.tool) {
      case 'line': {
        const prev = this.pts[this.pts.length - 1].uv;
        let dx = c[0] - prev[0], dy = c[1] - prev[1];
        if (!Math.hypot(dx, dy)) { dx = 1; dy = 0; }
        const l = Math.hypot(dx, dy);
        this.snapInfo = Math.abs(dy) < 1e-9 ? 'horizontal' : Math.abs(dx) < 1e-9 ? 'vertical' : null;
        this.place({ uv: rp([prev[0] + (dx / l) * vals[0], prev[1] + (dy / l) * vals[0]]), typed: vals });
        break;
      }
      case 'rect': this.finishShape({ uv: rp([a[0] + sx * vals[0], a[1] + sy * vals[1]]), typed: vals }); break;
      case 'crect': this.finishShape({ uv: rp([a[0] + (sx * vals[0]) / 2, a[1] + (sy * vals[1]) / 2]), typed: vals }); break;
      case 'circle': this.finishShape({ uv: rp([a[0] + vals[0] / 2, a[1]]), typed: vals }); break;
    }
    this.vp.renderer.domElement.focus();
  }

  onKey(e) {
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.key === 'Escape') {
      if (this.pts.length || this.dimPick) this.endChain(); else this.setTool('select');
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected.size) {
      this.deleteSelected();
    } else if ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase())) {
      // Ctrl+Z undoes; Ctrl+Y or Ctrl+Shift+Z redoes.
      e.preventDefault();
      e.stopPropagation();
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) this.restore(this.undoStack, this.redoStack);
      else this.restore(this.redoStack, this.undoStack);
    } else if (/^[0-9.]$/.test(e.key) && this.pts.length) {
      const inp = this.dimBox.querySelector('input');
      if (inp) { inp.value = ''; inp.focus(); }
    } else if (!e.ctrlKey && !e.altKey) {
      const map = { l: 'line', r: 'rect', c: 'circle', a: 'arc', s: 'select', d: 'dimension', t: 'trim', p: 'project' };
      if (map[e.key]) this.setTool(map[e.key]);
      if (e.key === 'x') this.toggleConstruction();
      if (e.key === 'o') this.offsetSelected();
    }
  }

  // ---------- display ----------

  rubberBand() {
    const c = this.cursor?.uv, pts = this.pts.map((p) => p.uv);
    if (!c || !pts.length) return null;
    const a = pts[0];
    switch (this.tool) {
      case 'line': return { t: 'line', a: pts[pts.length - 1], b: c };
      case 'rect': return { t: 'rect', a, b: c };
      case 'crect': return { t: 'rect', a: [2 * a[0] - c[0], 2 * a[1] - c[1]], b: c };
      case 'circle': return { t: 'circle', c: a, r: dist2(a, c) };
      case 'polygon': {
        const n = Math.max(3, Math.round(this.settings.sides)), r = dist2(a, c), a0 = Math.atan2(c[1] - a[1], c[0] - a[0]);
        const corner = (k) => [a[0] + r * Math.cos(a0 + (k * 2 * Math.PI) / n), a[1] + r * Math.sin(a0 + (k * 2 * Math.PI) / n)];
        return { segs: Array.from({ length: n }, (_, k) => [corner(k), corner(k + 1)]).flat() };
      }
      case 'slot': {
        if (pts.length === 1) return { t: 'line', a, b: c };
        const b = pts[1], r = distToLine(c, a, b);
        const d = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(...d) || 1, n = [-d[1] / l * r, d[0] / l * r];
        const ring = (q) => Array.from({ length: 32 }, (_, k) => [q[0] + r * Math.cos((k * Math.PI) / 16), q[1] + r * Math.sin((k * Math.PI) / 16)]);
        const segs = [[a[0] + n[0], a[1] + n[1]], [b[0] + n[0], b[1] + n[1]], [a[0] - n[0], a[1] - n[1]], [b[0] - n[0], b[1] - n[1]]];
        for (const q of [a, b]) { const rp2 = ring(q); rp2.forEach((p, k) => segs.push(p, rp2[(k + 1) % 32])); }
        return { segs };
      }
      case 'arc':
        if (pts.length === 1) return { t: 'line', a, b: c };
        return circleFrom3(pts[0], c, pts[1]) ? { t: 'arc', a: pts[0], b: pts[1], m: c } : { t: 'line', a: pts[0], b: pts[1] };
    }
    return null;
  }

  colorOf(id) {
    if (this.selected.has(id)) return COLOR.select;
    if (this.hover?.id === id || this.dimPick?.id === id) return COLOR.hover;
    return this.info.fixed.has(id) ? COLOR.fixed : COLOR.free;
  }

  refresh() {
    const sk = this.params;
    const display = M.toEntities(sk, true);
    const byId = new Map(sk.curves.map((c) => [c.id, c]));
    this.app.showSketches({
      frame: this.frame,
      entities: display,
      regionEntities: sk.entities,
      colors: display.map((e) => (byId.get(e.id).construction && !this.selected.has(e.id) ? COLOR.construction : this.colorOf(e.id))),
      dashed: display.map((e) => !!byId.get(e.id).construction),
      noDots: true,
      active: true,
      showRegions: true,
      selectedRegions: [],
    });
    this.labels?.set(this.labelItems());
    this.refreshOverlay();
  }

  refreshOverlay() {
    const sk = this.params;
    const items = [];
    const w = (p) => toWorld(this.frame, p[0], p[1]);
    // Points: black once fixed, blue while free.
    const groups = new Map();
    for (const p of sk.points) {
      const col = this.colorOf(p.id);
      if (!groups.has(col)) groups.set(col, []);
      groups.get(col).push(w([p.x, p.y]));
    }
    for (const [color, points] of groups) items.push({ kind: 'points', points, color, size: 6 });
    const rb = PICK_TOOLS.has(this.tool) ? null : this.rubberBand();
    if (rb) items.push({ kind: 'polyline', points: (rb.segs || this.app.polylineSegments(rb)).map(w), color: COLOR.select });
    if (this.tool === 'project' && this.hover?.kind === 'edge') items.push({ kind: 'edge', points: this.hover.points, color: COLOR.hover });
    if (this.cursor && !PICK_TOOLS.has(this.tool)) {
      const big = this.snapInfo === 'point' || this.snapInfo === 'curve';
      items.push({ kind: 'points', points: [w(this.cursor.uv)], color: big ? 0xff8800 : COLOR.select, size: big ? 10 : 6 });
    }
    // Hovered curve in Select / Dimension.
    const hc = this.hover?.kind === 'curve' && M.toEntities(sk, true).find((e) => e.id === this.hover.id);
    if (hc) items.push({ kind: 'polyline', points: this.app.polylineSegments(hc).map(w), color: COLOR.hover });
    this.vp.setOverlay(items);
  }

  // Constraint icons and dimension values, placed next to what they belong to.
  labelItems() {
    const sk = this.params;
    const fr = this.frame;
    const dirW = (d) => [0, 1, 2].map((i) => fr.xDir[i] * d[0] + fr.yDir[i] * d[1]);
    const stacks = new Map();
    const out = [];
    for (const k of sk.constraints) {
      const dim = M.DIMENSIONS.has(k.type);
      const def = M.CONSTRAINTS[k.type];
      const refIdx = dim || k.type === 'onCurve' || k.type === 'midpoint' || k.type === 'fix' ? [0] : k.refs.map((_, i) => i);
      for (const i of refIdx) {
        let anchor;
        if (k.type === 'distance') {
          const A = M.xy(sk, k.refs[0]), B = M.xy(sk, k.refs[1]), d = M.sub(B, A), l = M.len(d) || 1;
          anchor = [[(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], [-d[1] / l, d[0] / l]];
        } else if (k.type === 'pointLine') {
          const P = M.xy(sk, k.refs[0]), [m] = M.labelAnchor(sk, k, 1);
          anchor = [[(P[0] + m[0]) / 2, (P[1] + m[1]) / 2], [0.7, 0.7]];
        } else anchor = M.labelAnchor(sk, k, i);
        if (!anchor) continue;
        const ref = k.refs[i];
        const n = stacks.get(ref) || 0;
        stacks.set(ref, n + 1);
        const text = dim ? dimText(k) : def?.icon || '?';
        out.push({
          key: `${k.id}:${i}`, id: k.id, text, world: toWorld(fr, anchor[0][0], anchor[0][1]), dir: dirW(anchor[1]),
          px: dim ? 24 : 14, stack: dim ? 0 : n,
          cls: `${dim ? 'dim' : 'con'}${this.selected.has(k.id) ? ' selected' : ''}`,
          title: dim ? 'Double-click to change. Click to select, Delete removes.' : `${def?.label || k.type}. Click to select, Delete removes.`,
        });
      }
    }
    return out;
  }

  // ---------- palette ----------

  renderPanel() {
    const body = this.app.openPanel('Sketch', [
      { label: 'Finish Sketch', primary: true, onClick: () => this.finish() },
      { label: 'Cancel', onClick: () => this.cancel() },
    ]);
    const planeSel = el('select', {}, ...Object.keys(PLANES).map((p) => el('option', { value: p, selected: p === this.params.plane }, p)));
    planeSel.addEventListener('change', () => { this.params.plane = planeSel.value; this.updateFrame(); });
    const offset = el('input', { type: 'text', value: this.params.offset });
    offset.addEventListener('change', () => { this.params.offset = num(offset.value) || 0; offset.value = this.params.offset; this.updateFrame(); });
    const grid = el('select', {}, ...[0, 0.1, 0.5, 1, 2, 5, 10].map((g) => el('option', { value: g, selected: g === this.grid }, g ? `${g} mm` : 'Off')));
    grid.addEventListener('change', () => { this.grid = Number(grid.value); });
    // Settings for the tools that need a number.
    const setting = (key, label) => {
      const inp = el('input', { type: 'text', value: this.settings[key] });
      inp.addEventListener('change', () => { const v = num(inp.value); if (v > 0) this.settings[key] = v; inp.value = this.settings[key]; this.refreshOverlay(); });
      return field(label, inp);
    };
    const toolSetting = { polygon: ['sides', 'Polygon sides'], fillet: ['fillet', 'Fillet radius (mm)'] }[this.tool];
    const dof = this.info.dof;
    const state = dof == null ? 'Loading the constraint solver…'
      : !this.params.curves.length ? 'Empty sketch'
        : dof === 0 ? 'Fully constrained' : `${dof} degree${dof === 1 ? '' : 's'} of freedom left`;
    body.append(
      ...(this.params.frame ? [el('p', { class: 'muted' }, 'On a face.')] : [field('Plane', planeSel), field('Offset (mm)', offset)]),
      field('Grid snap', grid),
      el('button', { class: 'btn small', onclick: () => this.lookAt() }, 'Look At'),
      ...(toolSetting ? [setting(...toolSetting)] : []),
      setting('offset', 'Offset distance (mm)'),
      el('div', { class: `sel-info ${dof === 0 ? 'done' : ''}` }, el('span', {}, state)),
    );
    const n = this.selected.size;
    if (n) body.append(el('p', { class: 'muted' }, `${n} selected. Pick a constraint above, X toggles construction, Delete removes.`));
    body.append(el('p', { class: 'muted' }, 'Black is fully fixed, blue can still move. Drag with Select to try it.'));
  }

  updateFrame() {
    this.frame = planeFrame(this.params.plane, this.params.offset);
    this.lookAt();
    this.refresh();
  }

  finish() {
    M.pruneConstraints(this.params);
    this.params.entities = M.toEntities(this.params);
    this.stop();
    this.onFinish(this.params);
  }

  cancel() {
    this.stop();
    this.onCancel();
  }
}

function distToLine(p, a, b) {
  const d = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(...d) || 1;
  return Math.abs(d[0] * (p[1] - a[1]) - d[1] * (p[0] - a[0])) / l;
}

function dimText(k) {
  const v = fmt(k.value);
  return k.type === 'diameter' ? `Ø${v}` : k.type === 'radius' ? `R${v}` : k.type === 'angle' ? `${v}°` : v;
}

// Closest point on a curve to p.
function projectOnto(sk, c, p) {
  if (c.t === 'line') {
    const A = M.xy(sk, c.p1), d = M.sub(M.xy(sk, c.p2), A);
    const t = Math.max(0, Math.min(1, ((p[0] - A[0]) * d[0] + (p[1] - A[1]) * d[1]) / ((d[0] ** 2 + d[1] ** 2) || 1)));
    return [A[0] + d[0] * t, A[1] + d[1] * t];
  }
  const C = M.xy(sk, c.c), r = c.t === 'circle' ? c.r : M.arcGeom(sk, c).r;
  const v = M.sub(p, C), l = M.len(v) || 1;
  return [C[0] + (v[0] / l) * r, C[1] + (v[1] / l) * r];
}
