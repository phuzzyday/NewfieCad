// Feature dialogs: each edits a feature's params with live preview and viewport picking.

import * as THREE from 'three';
import { el, field, num } from './ui.js';
import { buildProfiles, sketchFrame, PLANES } from './profiles.js';
import { Gizmo } from './gizmo.js';
import {
  STAGES, primFrame, dragSize, dragHeight, typedSize, primArrows, applyPrimArrow, extrudeArrow, applyExtrudeArrow,
} from './shape-drag.js';
import { primitiveOutline, pressPullOutline, extrudeOutline, moveOutline } from './outline.js';

const OPS = [['join', 'Join'], ['cut', 'Cut'], ['new', 'New Body']];
const PRIM_OPS = [['new', 'New Body'], ['join', 'Join'], ['cut', 'Cut']];
const AXIS_OPTS = [['x', 'X'], ['y', 'Y'], ['z', 'Z']];
const MODE_FIELD = { key: 'mode', label: 'Repeat', type: 'select', options: [['bodies', 'Bodies'], ['features', 'Features']] };
const patternPick = (p) => (p.mode === 'features' ? 'features' : 'bodies');
const patternDefaults = (extra) => () => ({ mode: 'bodies', bodies: [], features: [], ...extra });

// Primitives are placed by clicking a plane or flat face; sizes are typed in.
function primitive(label, icon, sizes, sizeFields, canFlip = true) {
  return {
    label, icon, pick: 'place',
    defaults: () => ({ point: null, normal: null, xDir: null, face: null, ...sizes, op: 'new', flip: false }),
    fields: [
      ...sizeFields.map(([key, l]) => ({ key, label: l, type: 'number' })),
      { key: 'op', label: 'Operation', type: 'select', options: PRIM_OPS },
      ...(canFlip ? [{ key: 'flip', label: 'Flip direction', type: 'checkbox' }] : []),
    ],
  };
}

export const FEATURE_TYPES = {
  sketch: { label: 'Sketch', icon: 'sketch' },
  extrude: {
    label: 'Extrude', icon: 'extrude', pick: 'regions',
    defaults: (app, stopAt) => ({
      sketch: app.lastSketchId(stopAt), profiles: 'all', distance: 10, direction: 'one',
      op: app.hasBodies() ? 'join' : 'new',
    }),
    fields: [
      { key: 'distance', label: 'Distance (mm)', type: 'number', flip: true },
      { key: 'direction', label: 'Direction', type: 'select', options: [['one', 'One side'], ['symmetric', 'Symmetric']] },
      { key: 'op', label: 'Operation', type: 'select', options: OPS },
    ],
  },
  revolve: {
    label: 'Revolve', icon: 'revolve', pick: 'regions',
    defaults: (app, stopAt) => ({
      sketch: app.lastSketchId(stopAt), profiles: 'all', axis: 'y', angle: 360,
      op: app.hasBodies() ? 'join' : 'new',
    }),
    fields: [
      { key: 'axis', label: 'Axis', type: 'select', options: [['y', 'Sketch vertical axis'], ['x', 'Sketch horizontal axis']] },
      { key: 'angle', label: 'Angle (°)', type: 'number' },
      { key: 'op', label: 'Operation', type: 'select', options: OPS },
    ],
  },
  fillet: {
    label: 'Fillet', icon: 'fillet', pick: 'edges',
    defaults: () => ({ edges: [], radius: 1 }),
    fields: [{ key: 'radius', label: 'Radius (mm)', type: 'number' }],
  },
  chamfer: {
    label: 'Chamfer', icon: 'chamfer', pick: 'edges',
    defaults: () => ({ edges: [], distance: 1 }),
    fields: [{ key: 'distance', label: 'Distance (mm)', type: 'number' }],
  },
  shell: {
    // Remove faces for an open shell; with no faces (or Type: Hollow) the body is hollowed sealed.
    label: 'Shell', icon: 'shell', pick: (p) => (p.mode === 'bodies' ? 'bodies' : 'faces'),
    hint: { faces: 'Click faces to remove for an open shell, or pick none to hollow the body sealed.' },
    defaults: () => ({ mode: 'faces', faces: [], bodies: [], thickness: 2 }),
    fields: [
      { key: 'mode', label: 'Type', type: 'select', options: [['faces', 'Remove faces'], ['bodies', 'Hollow (sealed)']] },
      { key: 'thickness', label: 'Wall thickness (mm)', type: 'number' },
    ],
  },
  hole: {
    label: 'Hole', icon: 'hole', pick: 'point',
    defaults: () => ({ point: null, normal: null, diameter: 5, depth: 10, through: false, kind: 'simple', cbDiameter: 9, cbDepth: 3 }),
    fields: [
      { key: 'kind', label: 'Type', type: 'select', options: [['simple', 'Simple'], ['counterbore', 'Counterbore']] },
      { key: 'diameter', label: 'Diameter (mm)', type: 'number' },
      { key: 'through', label: 'Through all', type: 'checkbox' },
      { key: 'depth', label: 'Depth (mm)', type: 'number', hideIf: (p) => p.through },
      { key: 'cbDiameter', label: 'Counterbore Ø (mm)', type: 'number', hideIf: (p) => p.kind !== 'counterbore' },
      { key: 'cbDepth', label: 'Counterbore depth (mm)', type: 'number', hideIf: (p) => p.kind !== 'counterbore' },
    ],
  },
  pressPull: {
    label: 'Press Pull', icon: 'pressPull', pick: 'face',
    defaults: () => ({ face: null, normal: null, distance: 0 }),
    fields: [{ key: 'distance', label: 'Distance (mm)', type: 'number', flip: true }],
  },
  combine: {
    label: 'Combine', icon: 'combine', pick: 'combine',
    defaults: () => ({ target: null, tools: [], op: 'join', keep: false }),
    fields: [
      { key: 'op', label: 'Operation', type: 'select', options: [['join', 'Join'], ['cut', 'Cut'], ['intersect', 'Intersect']] },
      { key: 'keep', label: 'Keep tool bodies', type: 'checkbox' },
    ],
  },
  scale: {
    label: 'Scale', icon: 'scale', pick: 'bodies',
    defaults: () => ({ bodies: [], pivot: null, about: 'center', factor: 1 }),
    fields: [
      { key: 'factor', label: 'Scale factor', type: 'number' },
      { key: 'about', label: 'Scale about', type: 'select', options: [['center', 'Centre of the bodies'], ['origin', 'Origin']] },
    ],
  },
  split: {
    // First a plane or face, then (optionally) the bodies to split.
    label: 'Split Body', icon: 'split', pick: (p) => (p.normal ? 'bodies' : 'plane'),
    hint: { bodies: 'Drag the arrow to move the cut. Click bodies to split only those (none = every body it crosses).' },
    defaults: () => ({ point: null, normal: null, face: null, offset: 0, bodies: [], keep: 'both' }),
    fields: [
      { key: 'offset', label: 'Offset (mm)', type: 'number', flip: true },
      { key: 'keep', label: 'Keep', type: 'select', options: [['both', 'Both halves'], ['front', 'Arrow side only'], ['back', 'Other side only']] },
    ],
  },
  remove: {
    label: 'Remove', icon: 'remove', pick: 'bodies',
    defaults: () => ({ bodies: [] }),
    fields: [],
  },
  stl: {
    label: 'STL', title: 'Insert STL', icon: 'stl', pick: 'none',
    fields: [
      { key: 'units', label: 'File units', type: 'select', options: [['mm', 'Millimetres'], ['cm', 'Centimetres'], ['in', 'Inches']] },
      { key: 'sx', label: 'Scale X', type: 'number' },
      { key: 'sy', label: 'Scale Y', type: 'number' },
      { key: 'sz', label: 'Scale Z', type: 'number' },
      { key: 'center', label: 'Centre it on the origin and stand it on XY', type: 'checkbox' },
      { key: 'op', label: 'Operation', type: 'select', options: PRIM_OPS },
    ],
  },
  move: {
    label: 'Move', title: 'Move / Copy', icon: 'move', pick: 'bodies', gizmo: true,
    defaults: () => ({ bodies: [], pivot: null, dx: 0, dy: 0, dz: 0, axis: 'z', angle: 0, copy: false }),
    fields: [
      { key: 'dx', label: 'Move X (mm)', type: 'number' },
      { key: 'dy', label: 'Move Y (mm)', type: 'number' },
      { key: 'dz', label: 'Move Z (mm)', type: 'number' },
      { key: 'axis', label: 'Rotate around', type: 'select', options: AXIS_OPTS },
      { key: 'angle', label: 'Angle (°)', type: 'number' },
      { key: 'copy', label: 'Keep original (copy)', type: 'checkbox' },
    ],
  },
  rectPattern: {
    label: 'Rectangular Pattern', icon: 'rectPattern', pick: patternPick,
    defaults: patternDefaults({ dir1: 'x', count1: 3, spacing1: 20, dir2: 'none', count2: 2, spacing2: 20 }),
    fields: [
      MODE_FIELD,
      { key: 'dir1', label: 'Direction 1', type: 'select', options: AXIS_OPTS },
      { key: 'count1', label: 'Count 1', type: 'number' },
      { key: 'spacing1', label: 'Spacing 1 (mm)', type: 'number', flip: true },
      { key: 'dir2', label: 'Direction 2', type: 'select', options: [['none', 'None'], ...AXIS_OPTS] },
      { key: 'count2', label: 'Count 2', type: 'number', hideIf: (p) => p.dir2 === 'none' },
      { key: 'spacing2', label: 'Spacing 2 (mm)', type: 'number', flip: true, hideIf: (p) => p.dir2 === 'none' },
    ],
  },
  circPattern: {
    label: 'Circular Pattern', icon: 'circPattern', pick: patternPick,
    defaults: patternDefaults({ axis: 'z', cx: 0, cy: 0, cz: 0, count: 6, angle: 360 }),
    fields: [
      MODE_FIELD,
      { key: 'axis', label: 'Axis', type: 'select', options: AXIS_OPTS },
      { key: 'cx', label: 'Axis through X', type: 'number' },
      { key: 'cy', label: 'Axis through Y', type: 'number' },
      { key: 'cz', label: 'Axis through Z', type: 'number' },
      { key: 'count', label: 'Count (with original)', type: 'number' },
      { key: 'angle', label: 'Total angle (°)', type: 'number' },
    ],
  },
  mirror: {
    label: 'Mirror', icon: 'mirror', pick: patternPick,
    defaults: patternDefaults({ plane: 'YZ', offset: 0 }),
    fields: [
      MODE_FIELD,
      { key: 'plane', label: 'Mirror plane', type: 'select', options: [['YZ', 'YZ (flips X)'], ['XZ', 'XZ (flips Y)'], ['XY', 'XY (flips Z)']] },
      { key: 'offset', label: 'Plane offset (mm)', type: 'number' },
    ],
  },
  box: primitive('Box', 'box', { width: 20, depth: 20, height: 20 },
    [['width', 'Width X (mm)'], ['depth', 'Depth Y (mm)'], ['height', 'Height (mm)']]),
  cylinder: primitive('Cylinder', 'cylinder', { diameter: 20, height: 20 },
    [['diameter', 'Diameter (mm)'], ['height', 'Height (mm)']]),
  sphere: primitive('Sphere', 'sphere', { diameter: 20 }, [['diameter', 'Diameter (mm)']], false),
  torus: primitive('Torus', 'torus', { ringDiameter: 30, tubeDiameter: 6 },
    [['ringDiameter', 'Ring diameter (mm)'], ['tubeDiameter', 'Tube diameter (mm)']], false),
  cone: primitive('Cone', 'cone', { bottomDiameter: 20, topDiameter: 0, height: 20 },
    [['bottomDiameter', 'Bottom diameter (mm)'], ['topDiameter', 'Top diameter (mm)'], ['height', 'Height (mm)']]),
};

export const PRIMITIVES = ['box', 'cylinder', 'sphere', 'torus', 'cone'];
export const PATTERNS = ['rectPattern', 'circPattern'];

// Features that add or remove a solid; only these can be patterned or mirrored.
const PATTERNABLE = new Set(['extrude', 'revolve', 'hole', 'stl', ...PRIMITIVES]);

const PICK_HINT = {
  regions: 'Click profiles to choose them (all are used by default). Drag the arrow to set the distance.',
  edges: 'Click edges to add or remove them.',
  faces: 'Click the faces to remove (for example the top face).',
  point: 'Click a flat face where the hole should go.',
  face: 'Click a flat face, then drag the arrow or type a distance. Out adds material, in removes it.',
  place: 'Click an origin plane or a flat face to place it, then set sizes in the panel.',
  plane: 'Click an origin plane or a flat face to start the cut from.',
  bodies: 'Click bodies to select them.',
  features: 'Tick the features to repeat in the panel.',
  none: 'Set the units and scale. Use Move afterwards to position it.',
  combine: 'Click the target body (blue), then the tool bodies (orange). Clicking again removes one.',
};

const STAGE_HINT = {
  size: (t) => (t === 'box'
    ? 'Move to size the base, then click. Or type Width, Tab, Depth and press Enter.'
    : 'Move to set the diameter, then click. Or type it and press Enter.'),
  height: (t) => (t === 'torus'
    ? 'Move to set the tube thickness, then click. Or type it and press Enter.'
    : 'Move up or down to set the height, then click. Or type it and press Enter.'),
  adjust: () => 'Drag the shape to move it, drag the arrows to resize, or change the numbers. OK, or click empty space, to finish.',
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Distance along the line through c in direction dir (unit) closest to the mouse ray.
function axisParam(vp, ev, c, dir) {
  const r = vp.ray(ev).ray;
  const o = r.origin.toArray(), d = r.direction.toArray();
  const w0 = c.map((v, i) => v - o[i]);
  const b = dot(dir, d);
  const den = 1 - b * b;
  if (den < 1e-4) return null;
  return (b * dot(d, w0) - dot(dir, w0)) / den;
}

// An in-plane x direction for a face normal: world X (or Y) projected onto the face.
function xDirFor(n) {
  const ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const d = ref[0] * n[0] + ref[1] * n[1] + ref[2] * n[2];
  const x = ref.map((v, i) => v - d * n[i]);
  const l = Math.hypot(...x);
  return x.map((v) => v / l);
}

export class FeatureDialog {
  constructor(app, { type, index = null, params = null, preselect = null }) {
    this.app = app;
    this.vp = app.vp;
    this.type = type;
    this.def = FEATURE_TYPES[type];
    this.index = index;
    this.stopAt = index ?? app.doc.features.length;
    this.params = params ? structuredClone(params) : this.def.defaults(app, this.stopAt);
    this.featureId = index != null ? app.doc.features[index].id : app.newId(type);
    this.hover = null;
    this.timer = null;
    this.preselect = params ? null : preselect;
    this.slot = this.params.target ? 'tools' : 'target'; // where Combine's next click goes
    this.autoPicked = new Set(); // picking modes already given their only body
    this.stage = null; // new primitives: 'point', then 'size', then 'height', then null
    this.arrows = []; // resize arrows: [{ key, gizmo }]
  }

  start() {
    if ((this.pick === 'regions') && !this.params.sketch) {
      this.app.setStatus('Create a sketch with a closed shape first.', 'warn');
      this.app.endEdit();
      return false;
    }
    this.vp.tool = this;
    this.showPlanes();
    if (this.def.gizmo) this.gizmo = new Gizmo(this.vp);
    if (this.type === 'shell' && this.preselect?.length && this.preselect.every((it) => it.kind === 'body')) this.params.mode = 'bodies';
    if (this.preselect?.length) this.applySelection(this.preselect);
    // A new primitive is drawn: click a point, drag its size, then its height.
    if (this.pick === 'place' && this.index == null) this.beginStage(this.params.point ? 'size' : 'point');
    this.keyHandler = (e) => this.onKey(e);
    window.addEventListener('keydown', this.keyHandler);
    this.render();
    this.update();
    return true;
  }

  stop() {
    clearTimeout(this.timer);
    this.vp.tool = null;
    this.vp.setOverlay([]);
    if (this.planesShown) this.vp.showOriginPlanes(this.app.showOrigin);
    this.planesShown = false;
    this.gizmo?.dispose();
    this.gizmo = null;
    this.arrows.forEach((a) => a.gizmo.dispose());
    this.arrows = [];
    this.arrowKey = null;
    window.removeEventListener('keydown', this.keyHandler);
    this.hideDim();
    this.vp.setOutline(null);
    this.vp.renderer.domElement.style.cursor = '';
  }

  // The origin planes are shown while a plane can be clicked.
  showPlanes() {
    const want = this.pick === 'place' || this.pick === 'plane';
    if (want === !!this.planesShown) return;
    this.vp.showOriginPlanes(want || this.app.showOrigin);
    this.planesShown = want;
    this.hoverPlane = null;
  }

  // ---------- Split Body's cut plane ----------

  setSplitPlane(hit) {
    const p = this.params;
    if (hit.kind === 'plane') {
      Object.assign(p, { normal: PLANES[hit.name].normal, point: [0, 0, 0], face: null });
    } else {
      if (!hit.flat) { this.app.setStatus('Pick a flat face, or an origin plane.', 'warn'); return false; }
      Object.assign(p, { normal: hit.sig.n, point: (hit.point || hit.sig.c).map((v) => Math.round(v * 1000) / 1000), face: hit.sig });
    }
    p.offset = 0;
    this.hover = null;
    this.showPlanes();
    return true;
  }

  // The cut plane as a square around the bodies it splits: { center, corners }.
  splitSquare() {
    const p = this.params;
    if (!p.normal) return null;
    const n = p.normal;
    const box = new THREE.Box3();
    for (const b of this.vp.bodyData) {
      if (p.bodies.length ? !p.bodies.includes(b.id) : !b.mesh) continue;
      for (let i = 0; i < b.vertices.length; i += 3) box.expandByPoint(new THREE.Vector3(b.vertices[i], b.vertices[i + 1], b.vertices[i + 2]));
    }
    const o = p.point.map((v, i) => v + n[i] * (Number(p.offset) || 0));
    const c0 = box.isEmpty() ? o : box.getCenter(new THREE.Vector3()).toArray();
    const center = c0.map((v, i) => v - n[i] * dot(c0.map((w, k) => w - o[k]), n));
    const h = box.isEmpty() ? 20 : Math.max(...box.getSize(new THREE.Vector3()).toArray()) * 0.6 + 5;
    const u = xDirFor(n), v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const at = (a, b) => center.map((x, i) => x + (u[i] * a + v[i] * b) * h);
    return { center, corners: [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)] };
  }

  // While dragging, an outline drawn straight from the numbers follows the mouse at once.
  showOutline() {
    let o = null;
    if (this.pick === 'place') o = primitiveOutline(this.type, this.params);
    else if (this.type === 'pressPull') o = pressPullOutline(this.vp, this.params);
    else if (this.type === 'extrude') o = extrudeOutline(this.app, this.params);
    else if (this.type === 'move') o = moveOutline(this.vp, this.params);
    this.vp.setOutline(o);
  }

  // ---------- drawing a new primitive ----------

  beginStage(stage) {
    this.stage = stage;
    if (stage === 'size') this.anchor = this.params.point.slice();
  }

  advanceStage() {
    if (this.stage === 'point') this.beginStage('size');
    else if (this.stage === 'size' && STAGES[this.type].length > 1) this.stage = 'height';
    else this.stage = null;
    this.hideDim();
    this.vp.setOutline(null);
    this.render();
    this.update();
  }

  dragging() { return this.stage === 'size' || this.stage === 'height'; }

  // The plane through the first click, for the size step (and a torus's tube).
  stageFrame() {
    const { x, y } = primFrame({ ...this.params, point: this.anchor });
    return { origin: this.anchor, xDir: x, yDir: y, normal: this.params.normal };
  }

  // Sizes snap to 1 mm; hold Shift for 0.1 mm.
  dragStage(ev) {
    const p = this.params, step = ev.shiftKey ? 0.1 : 1;
    const uv = this.vp.planeHit(ev, this.stageFrame());
    if (this.stage === 'size') {
      if (!uv) return;
      this.lastUV = uv;
      dragSize(this.type, p, this.anchor, uv, step);
    } else {
      const t = axisParam(this.vp, ev, p.point, p.normal);
      if (this.type === 'torus' ? !uv : t == null) return;
      dragHeight(this.type, p, t, uv, step);
    }
    this.lastEv = ev;
    this.render();
    this.showOutline();
    this.update(true, true);
    this.showDim();
  }

  // Box at the cursor for typing exact sizes, as in sketches.
  showDim() {
    const fields = STAGES[this.type]?.[this.stage === 'size' ? 0 : 1];
    const box = document.getElementById('dim-box');
    if (!fields || !this.lastEv) return;
    if (box.dataset.stage !== this.stage) {
      box.innerHTML = '';
      box.dataset.stage = this.stage;
      for (const [key, label] of fields) {
        const inp = el('input', { type: 'text', title: label, placeholder: label });
        inp.dataset.key = key;
        inp.addEventListener('keydown', (e) => this.onDimKey(e));
        box.append(el('label', {}, label, inp));
      }
    }
    for (const inp of box.querySelectorAll('input')) {
      if (document.activeElement !== inp && !inp.dataset.typed) inp.value = this.params[inp.dataset.key];
    }
    const r = this.vp.el.getBoundingClientRect();
    box.style.left = `${this.lastEv.clientX - r.left + 18}px`;
    box.style.top = `${this.lastEv.clientY - r.top + 18}px`;
    box.hidden = false;
  }

  hideDim() {
    const box = document.getElementById('dim-box');
    if (!box || !box.dataset.stage) return;
    box.hidden = true;
    box.innerHTML = '';
    delete box.dataset.stage;
  }

  onDimKey(e) {
    e.stopPropagation();
    e.target.dataset.typed = '1';
    if (e.key === 'Escape') { this.hideDim(); this.vp.renderer.domElement.focus(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const vals = [...document.querySelectorAll('#dim-box input')].map((i) => num(i.value));
    if (vals.some((v) => !(v > 0))) { this.app.setStatus('Enter a number greater than zero.', 'warn'); return; }
    const p = this.params;
    if (this.stage === 'size') typedSize(this.type, p, this.anchor, vals, this.lastUV || [1, 1]);
    else if (this.type === 'torus') p.tubeDiameter = vals[0];
    else p.height = vals[0];
    this.advanceStage();
    this.vp.renderer.domElement.focus();
  }

  // Typing a digit while dragging goes into the size box.
  onKey(e) {
    if (!this.dragging() || e.target.closest?.('input, select, textarea')) return;
    if (/^[0-9.]$/.test(e.key)) {
      const inp = document.querySelector('#dim-box input');
      if (inp) { inp.value = ''; inp.focus(); }
    }
  }

  // ---------- resize arrows (placed primitives, Extrude) ----------

  arrowList() {
    if (this.type === 'extrude') { const a = extrudeArrow(this.app, this.params); return a ? [a] : []; }
    if (this.pick === 'place' && !this.stage) return primArrows(this.type, this.params);
    return [];
  }

  placeArrows() {
    const list = this.arrowList();
    const key = list.map((a) => a.key + a.dir.map((v) => v.toFixed(4)).join()).join('|');
    if (key !== this.arrowKey) {
      this.arrows.forEach((a) => a.gizmo.dispose());
      this.arrows = list.map((a) => ({ key: a.key, gizmo: new Gizmo(this.vp, { axes: { n: a.dir }, rings: false, size: 70 }) }));
      this.arrowKey = key;
    }
    list.forEach((a, i) => this.arrows[i].gizmo.setCenter(a.pos));
  }

  // ---------- sliding a placed primitive ----------

  // Once a primitive is drawn (or when editing one), it can be dragged along its plane.
  canSlide() {
    const p = this.params;
    return this.pick === 'place' && !this.stage && p.point && p.normal && p.xDir;
  }

  // The point grabbed when the mouse is over the shape itself or its base point, else null.
  overShape(ev) {
    if (!this.canSlide()) return null;
    const rc = this.vp.ray(ev);
    if (rc.ray.distanceToPoint(new THREE.Vector3(...this.params.point)) < this.vp.unitsPerPixel() * 10) return this.params.point;
    const o = primitiveOutline(this.type, this.params);
    if (!o) return null;
    const mesh = new THREE.Mesh(o.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.applyMatrix4(o.matrix);
    mesh.updateMatrixWorld();
    const hit = rc.intersectObject(mesh)[0];
    o.geometry.dispose();
    mesh.material.dispose();
    return hit ? hit.point.toArray() : null;
  }

  slideFrame(origin) {
    const { x, y } = primFrame(this.params);
    return { origin, xDir: x, yDir: y, normal: this.params.normal };
  }

  // The sizes stay as they are; only the base point moves, in 1 mm steps (Shift: 0.1 mm).
  // The drag runs in a plane through the grabbed spot, so that spot stays under the mouse.
  slideTo(ev) {
    const { start, grab, uv0 } = this.slide;
    const fr = this.slideFrame(start);
    const uv = this.vp.planeHit(ev, { ...fr, origin: grab });
    if (!uv) return;
    const step = ev.shiftKey ? 0.1 : 1;
    const du = Math.round((uv[0] - uv0[0]) / step) * step, dv = Math.round((uv[1] - uv0[1]) / step) * step;
    this.params.point = start.map((v, i) => Math.round((v + fr.xDir[i] * du + fr.yDir[i] * dv) * 1000) / 1000);
    this.render();
    this.showOutline();
    this.update(true, true);
  }

  // Highlight an arrow under the mouse; true if there is one.
  hoverArrows(ev) {
    let found = false;
    for (const a of this.arrows) {
      const h = found ? null : a.gizmo.hit(ev);
      a.gizmo.setHover(h);
      if (h) found = true;
    }
    return found;
  }

  // Some dialogs pick bodies or features depending on a setting.
  get pick() { return typeof this.def.pick === 'function' ? this.def.pick(this.params) : this.def.pick; }

  placesPoint() { return this.pick === 'point' || this.pick === 'place'; }

  // Items selected before the command started become its first picks.
  applySelection(items) {
    const p = this.params;
    const flatFace = items.find((it) => it.kind === 'face' && it.flat);
    switch (this.pick) {
      case 'edges': p.edges = items.filter((it) => it.kind === 'edge').map((it) => it.sig); break;
      case 'faces': p.faces = items.filter((it) => it.kind === 'face').map((it) => it.sig); break;
      case 'bodies':
        p.bodies = [...new Set(items.map((it) => it.body))];
        if (this.type === 'move' || this.type === 'scale') p.pivot = this.vp.bodiesCenter(p.bodies);
        break;
      case 'face': if (flatFace) { p.face = flatFace.sig; p.normal = flatFace.sig.n; } break;
      case 'combine': {
        const ids = [...new Set(items.map((it) => it.body))];
        p.target = ids[0] || null;
        p.tools = ids.slice(1);
        this.slot = p.target ? 'tools' : 'target';
        break;
      }
      case 'point': case 'place': if (flatFace) this.placeOnFace(flatFace); break;
      case 'plane':
        // Split: a selected face sets the plane, selected bodies are the ones to split.
        p.bodies = [...new Set(items.filter((it) => it.kind === 'body').map((it) => it.body))];
        if (flatFace) this.setSplitPlane({ ...flatFace, kind: 'face' });
        break;
    }
  }

  placeOnFace(hit) {
    const p = this.params;
    p.point = hit.point.map((v) => Math.round(v * 1000) / 1000);
    p.normal = hit.normal;
    p.face = hit.sig;
    if (this.pick === 'place') p.xDir = xDirFor(hit.normal);
  }

  draft() { return { id: this.featureId, type: this.type, params: this.params }; }

  // Rebuild the preview shortly after the last change. While dragging (`fast`) it runs at
  // once on every move; the kernel drops requests it hasn't started, so it never falls behind.
  update(now = false, fast = false) {
    clearTimeout(this.timer);
    this.valid = false; // until the new preview comes back without an error
    const run = async () => {
      const res = await this.app.previewFeature(this.stopAt, this.draft(), this.pick === 'edges', fast);
      if (!res) return;
      // No error while the user simply hasn't picked anything yet.
      const p = this.params;
      const nothingPicked = {
        edges: !p.edges?.length, faces: this.type !== 'shell' && !p.faces?.length, point: !p.point, place: !p.point,
        face: !p.face || !Number(p.distance),
        bodies: !p.bodies?.length && this.type !== 'split', plane: !p.normal, features: !p.features?.length, combine: !p.target || !p.tools?.length,
      }[this.pick];
      const error = res.draftError || res.errors?.[this.featureId] || '';
      this.errorBox.textContent = nothingPicked ? '' : error;
      this.valid = !nothingPicked && !error;
      this.refreshPicks();
    };
    if (now) run(); else this.timer = setTimeout(run, 120);
    this.refreshPicks();
  }

  // A new step that picks bodies starts with the only visible body, if there is just one.
  // Done once per picking mode, so clearing it afterwards sticks.
  autoPick() {
    if (this.index != null || this.pick !== 'bodies' || this.autoPicked.has(this.params.mode || 'bodies')) return;
    this.autoPicked.add(this.params.mode || 'bodies');
    const visible = this.app.bodies.filter((b) => !this.app.doc.hiddenBodies.includes(b.id));
    if (visible.length !== 1 || this.params.bodies.length) return;
    this.params.bodies = [visible[0].id];
    if (this.type === 'move' || this.type === 'scale') this.params.pivot = this.vp.bodiesCenter(this.params.bodies);
    this.app.renderTree();
  }

  render() {
    this.autoPick();
    const stageHint = this.pick === 'place' && this.stage !== 'point' && STAGE_HINT[this.stage || 'adjust'](this.type);
    this.app.setStatus(stageHint || this.def.hint?.[this.pick] || PICK_HINT[this.pick]);
    const body = this.app.openPanel(this.def.title || this.def.label, [
      { label: 'OK', primary: true, onClick: () => this.ok() },
      { label: 'Cancel', onClick: () => this.cancel() },
    ]);
    const p = this.params;
    if (this.pick === 'regions') {
      const sel = el('select', {}, ...this.app.sketchesBefore(this.stopAt).map((f) =>
        el('option', { value: f.id, selected: f.id === p.sketch }, f.name)));
      sel.addEventListener('change', () => { p.sketch = sel.value; p.profiles = 'all'; this.render(); this.update(); });
      body.append(field('Sketch', sel));
    }
    this.selInfo = el('div', { class: 'sel-info' });
    body.append(this.selInfo);
    if (this.type === 'split' && p.normal) {
      body.append(el('button', {
        class: 'btn small', title: 'Start the cut from a different plane or face',
        onclick: () => { Object.assign(p, { normal: null, point: null, face: null, offset: 0 }); this.showPlanes(); this.render(); this.update(); },
      }, 'Pick another plane'));
    }
    if (this.type === 'stl') this.selInfo.classList.add('no-clear');
    if (this.pick === 'features') body.append(this.featureList());
    if (this.pick === 'combine') {
      const slot = el('select', {}, ...[['target', 'Target body'], ['tools', 'Tool bodies']].map(([v, l]) =>
        el('option', { value: v, selected: v === this.slot }, l)));
      slot.addEventListener('change', () => { this.slot = slot.value; });
      body.append(field('Clicks pick', slot));
    }
    for (const f of this.def.fields) {
      if (f.hideIf?.(p)) continue;
      let input;
      if (f.type === 'number') {
        const box = el('input', { type: 'text', value: p[f.key] });
        box.addEventListener('change', () => {
          const v = num(box.value);
          if (Number.isFinite(v)) { p[f.key] = v; this.update(); }
          box.value = p[f.key];
        });
        input = box;
        if (f.flip) {
          const flip = el('button', { class: 'btn small', title: 'Flip direction' }, '⇅');
          flip.addEventListener('click', () => { p[f.key] = -p[f.key]; box.value = p[f.key]; this.update(); });
          input = el('div', { class: 'row' }, box, flip);
        }
      } else if (f.type === 'select') {
        input = el('select', {}, ...f.options.map(([v, l]) => el('option', { value: v, selected: v === p[f.key] }, l)));
        input.addEventListener('change', () => { p[f.key] = input.value; this.render(); this.update(); });
      } else if (f.type === 'checkbox') {
        input = el('input', { type: 'checkbox', checked: !!p[f.key] });
        input.addEventListener('change', () => { p[f.key] = input.checked; this.render(); this.update(); });
      }
      body.append(field(f.label, input));
    }
    if (this.placesPoint() && p.point) {
      ['X', 'Y', 'Z'].forEach((axis, i) => {
        const input = el('input', { type: 'text', value: Math.round(p.point[i] * 1000) / 1000 });
        input.addEventListener('change', () => {
          const v = num(input.value);
          if (Number.isFinite(v)) { p.point = p.point.map((c, k) => (k === i ? v : c)); this.update(); }
        });
        body.append(field(`Position ${axis}`, input));
      });
    }
    this.errorBox = el('div', { class: 'error-text' });
    body.append(this.errorBox);
    this.refreshPicks();
  }

  selectionText() {
    const p = this.params;
    switch (this.pick) {
      case 'regions': {
        const sk = this.app.featureById(p.sketch);
        const n = sk ? buildProfiles(sk.params.entities).regions.length : 0;
        return p.profiles === 'all' ? `Profiles: all (${n})` : `Profiles: ${p.profiles.length} of ${n}`;
      }
      case 'edges': return `Edges: ${p.edges.length} selected`;
      case 'faces':
        if (this.type === 'shell' && !p.faces.length) return 'No faces: hollow, sealed';
        return `Faces to remove: ${p.faces.length}`;
      case 'point': return p.point ? 'Hole position set' : 'Click a face to place the hole';
      case 'face': return p.face ? 'Face selected (click another to change)' : 'Click a flat face';
      case 'place': return p.point ? 'Position set (click again to move)' : 'Click a plane or flat face';
      case 'bodies':
        if (this.type === 'split' && !p.bodies.length) return 'Bodies: every one the plane crosses';
        return `Bodies: ${p.bodies.length} selected`;
      case 'plane': return 'Click an origin plane or a flat face';
      case 'combine': {
        const name = this.app.bodies.find((b) => b.id === p.target)?.name;
        return `Target: ${name || 'none'} · Tools: ${p.tools.length}`;
      }
      case 'none': {
        const n = (v) => Number(v).toLocaleString();
        return `${p.name}: ${n(p.tris)} triangles${p.origTris ? ` (simplified from ${n(p.origTris)})` : ''}`;
      }
      case 'features': return `Features: ${p.features.length} selected`;
    }
    return '';
  }

  clearSelection() {
    const p = this.params;
    if (this.pick === 'regions') p.profiles = 'all';
    if (this.pick === 'edges') p.edges = [];
    if (this.pick === 'faces') p.faces = [];
    if (this.placesPoint() || this.pick === 'face') { p.point = null; p.normal = null; p.face = null; this.render(); }
    if (this.pick === 'bodies') { p.bodies = []; this.selectionChanged(); }
    if (this.pick === 'features') { p.features = []; this.render(); }
    if (this.pick === 'combine') { p.target = null; p.tools = []; this.slot = 'target'; this.render(); this.app.renderTree(); }
    this.update();
  }

  refreshPicks() {
    if (this.selInfo) {
      this.selInfo.replaceChildren(el('span', {}, this.selectionText()),
        el('button', { class: 'btn small', onclick: () => this.clearSelection() }, 'Clear'));
    }
    const p = this.params;
    const items = [];
    if (this.pick === 'regions') {
      const sk = this.app.featureById(p.sketch);
      if (sk) {
        this.app.showSketches({
          frame: sketchFrame(sk.params), entities: sk.params.entities,
          showRegions: true, selectedRegions: p.profiles,
        });
      }
    }
    if (this.pick === 'edges') {
      for (const sig of p.edges) {
        const pts = this.vp.findEdge(sig);
        if (pts) items.push({ kind: 'edge', points: pts, color: 0x0a6cff });
      }
      if (this.hover?.kind === 'edge') items.push({ kind: 'edge', points: this.hover.points, color: 0x6fb6ff });
    }
    if (this.pick === 'faces') {
      for (const sig of p.faces) {
        const f = this.vp.findFace(sig);
        if (f) items.push({ kind: 'face', ...f, color: 0x0a6cff });
      }
      if (this.hover?.kind === 'face') items.push({ kind: 'face', body: this.hover.body, group: this.hover.group, color: 0x6fb6ff });
    }
    if (this.pick === 'face') {
      // Once pushed or pulled, the preview shows the result; only tint the face before that.
      const f = p.face && !Number(p.distance) && this.vp.findFace(p.face);
      if (f) items.push({ kind: 'face', ...f, color: 0x0a6cff });
      if (this.hover?.kind === 'face') items.push({ kind: 'face', body: this.hover.body, group: this.hover.group, color: 0x6fb6ff });
    }
    // Once a move is applied, the preview shows where the bodies went; don't tint over it.
    const moved = this.type === 'move' && [p.dx, p.dy, p.dz, p.angle].some((v) => Number(v));
    if (this.pick === 'bodies' && !moved) {
      for (const id of p.bodies) items.push({ kind: 'body', body: id, color: 0x0a6cff });
      if (this.hover?.kind === 'face' && !p.bodies.includes(this.hover.body)) items.push({ kind: 'body', body: this.hover.body, color: 0x6fb6ff });
    }
    if (this.pick === 'combine') {
      if (p.target) items.push({ kind: 'body', body: p.target, color: 0x0a6cff });
      for (const id of p.tools) items.push({ kind: 'body', body: id, color: 0xff8a00 });
      if (this.hover?.kind === 'face' && this.hover.body !== p.target && !p.tools.includes(this.hover.body)) {
        items.push({ kind: 'body', body: this.hover.body, color: 0x6fb6ff });
      }
    }
    if (this.pick === 'plane' && this.hover?.kind === 'face' && this.hover.flat) {
      items.push({ kind: 'face', body: this.hover.body, group: this.hover.group, color: 0x6fb6ff });
    }
    if (this.type === 'split') {
      const sq = this.splitSquare();
      if (sq) items.push({ kind: 'quad', corners: sq.corners, color: 0xff8a00 });
    }
    if (this.placesPoint()) {
      if (p.point) items.push({ kind: 'points', points: [p.point], color: 0x0a6cff, size: 10 });
      if (this.hover?.point) items.push({ kind: 'points', points: [this.hover.point], color: 0x6fb6ff, size: 8 });
    }
    this.vp.setOverlay(items);
    this.placeGizmo();
    this.placeArrows();
  }

  placeGizmo() {
    const p = this.params;
    if (this.type === 'pressPull') {
      // One arrow along the face's normal, at the face centre plus the distance.
      const key = p.face && p.normal ? p.normal.join() : null;
      if (key !== this.gizmoKey) {
        this.gizmo?.dispose();
        this.gizmo = key ? new Gizmo(this.vp, { axes: { n: p.normal }, rings: false }) : null;
        this.gizmoKey = key;
      }
      const d = Number(p.distance) || 0;
      this.gizmo?.setCenter(p.face.c.map((v, i) => v + p.normal[i] * d));
      return;
    }
    if (this.type === 'split') {
      // One arrow along the plane's normal, in the middle of the cut.
      const key = p.normal ? p.normal.join() : null;
      if (key !== this.gizmoKey) {
        this.gizmo?.dispose();
        this.gizmo = key ? new Gizmo(this.vp, { axes: { n: p.normal }, rings: false }) : null;
        this.gizmoKey = key;
      }
      this.gizmo?.setCenter(this.splitSquare()?.center ?? null);
      return;
    }
    if (!this.gizmo) return;
    this.gizmo.setCenter(p.pivot && p.bodies.length ? p.pivot.map((v, i) => v + (Number([p.dx, p.dy, p.dz][i]) || 0)) : null);
  }

  // ---------- gizmo dragging (Move) ----------

  onPointerDown(ev) {
    for (const a of this.arrows) {
      const ah = a.gizmo.hit(ev);
      if (ah && a.gizmo.begin(ev, ah)) { this.arrowDrag = { a, start: structuredClone(this.params) }; return true; }
    }
    const grab = this.overShape(ev);
    if (grab) {
      const start = this.params.point.slice();
      const uv0 = this.vp.planeHit(ev, this.slideFrame(grab));
      if (uv0) { this.slide = { start, grab, uv0 }; return true; }
    }
    const h = this.gizmo?.hit(ev);
    if (!h || !this.gizmo.begin(ev, h)) return false;
    const p = this.params;
    this.dragStart = {
      dx: Number(p.dx) || 0, dy: Number(p.dy) || 0, dz: Number(p.dz) || 0,
      angle: p.axis === h.axis ? Number(p.angle) || 0 : 0, distance: Number(p.distance) || 0,
      offset: Number(p.offset) || 0,
    };
    this.dragHandle = h;
    if (h.kind === 'rotate' && this.type === 'move') p.axis = h.axis;
    return true;
  }

  // Moves snap to 1 mm and turns to 5 degrees; hold Shift for 0.1 mm / 1 degree.
  onDrag(ev) {
    if (this.slide) { this.slideTo(ev); return; }
    if (this.arrowDrag) {
      const { a, start } = this.arrowDrag;
      const amt = a.gizmo.amount(ev);
      if (amt == null) return;
      const step = ev.shiftKey ? 0.1 : 1;
      if (this.type === 'extrude') applyExtrudeArrow(this.params, start, amt, step);
      else applyPrimArrow(this.type, this.params, start, a.key, amt, step);
      this.render();
      this.showOutline();
      this.update(true, true);
      return;
    }
    const amt = this.gizmo.amount(ev);
    if (amt == null) return;
    const p = this.params, h = this.dragHandle, st = this.dragStart;
    const snap = (v, step) => Math.round(v / step) * step;
    const clean = (v) => Math.round(v * 1000) / 1000;
    if (this.type === 'pressPull') {
      p.distance = clean(st.distance + snap(amt, ev.shiftKey ? 0.1 : 1));
      this.showOutline();
    } else if (this.type === 'split') {
      p.offset = clean(st.offset + snap(amt, ev.shiftKey ? 0.1 : 1));
    } else if (h.kind === 'move') {
      const key = `d${h.axis}`;
      p[key] = clean(st[key] + snap(amt, ev.shiftKey ? 0.1 : 1));
    } else {
      p.angle = clean((st.angle + snap(amt, ev.shiftKey ? 1 : 5)) % 360);
    }
    if (this.type === 'move') this.showOutline();
    this.render();
    this.update(true, true);
  }

  onDragEnd() {
    this.vp.setOutline(null);
    this.arrowDrag?.a.gizmo.end();
    this.arrowDrag = null;
    this.slide = null;
    this.gizmo?.end();
    this.update();
  }

  // Checklist of earlier features that can be repeated.
  featureList() {
    const p = this.params;
    const list = this.app.doc.features.slice(0, this.stopAt).filter((f) => PATTERNABLE.has(f.type) && !f.suppressed);
    if (!list.length) return el('p', { class: 'muted' }, 'No extrudes, holes or primitives before this step.');
    return el('div', { class: 'feature-list' }, ...list.map((f) => {
      const box = el('input', { type: 'checkbox', checked: p.features.includes(f.id) });
      box.addEventListener('change', () => {
        p.features = box.checked ? [...p.features, f.id] : p.features.filter((id) => id !== f.id);
        this.refreshPicks();
        this.update();
      });
      return el('label', { class: 'check' }, box, f.name);
    }));
  }

  // Move rotates, and Scale scales, about the centre of the selected bodies.
  selectionChanged() {
    if (this.type === 'move' || this.type === 'scale') this.params.pivot = this.vp.bodiesCenter(this.params.bodies);
    this.render();
    this.app.renderTree();
  }

  // Combine: the first click sets the target, later clicks add or remove tools.
  combinePick(id) {
    const p = this.params;
    if (this.slot === 'target' || !p.target) {
      p.target = p.target === id ? null : id;
      p.tools = p.tools.filter((t) => t !== id);
      if (p.target) this.slot = 'tools';
    } else if (id === p.target) {
      return;
    } else {
      p.tools = p.tools.includes(id) ? p.tools.filter((t) => t !== id) : [...p.tools, id];
    }
    this.render();
    this.app.renderTree();
    this.update();
  }

  toggleBody(id) {
    if (this.pick === 'combine') { this.combinePick(id); return; }
    if (this.pick !== 'bodies') return;
    const p = this.params;
    p.bodies = p.bodies.includes(id) ? p.bodies.filter((b) => b !== id) : [...p.bodies, id];
    this.selectionChanged();
    this.update();
  }

  // Middle-click toggles the body under the mouse in steps that pick bodies; elsewhere it does nothing.
  onMiddleClick(ev) {
    if (this.pick !== 'bodies' && this.pick !== 'combine') return;
    const hit = this.vp.pick(ev, { faces: true });
    if (hit) this.toggleBody(hit.body);
  }

  // Box selection adds to the picks.
  boxKind() { return { edges: 'edges', faces: 'faces', bodies: 'bodies', combine: 'bodies' }[this.pick] || null; }

  onBoxSelect(items) {
    const p = this.params;
    const same = (a, b) => Math.hypot(...a.map((v, i) => v - b[i])) < 1e-4;
    if (this.pick === 'edges') {
      for (const it of items) if (!p.edges.some((s) => same(s.m, it.sig.m))) p.edges.push(it.sig);
    } else if (this.pick === 'faces') {
      for (const it of items) if (!p.faces.some((s) => same(s.c, it.sig.c))) p.faces.push(it.sig);
    } else if (this.pick === 'bodies') {
      p.bodies = [...new Set([...p.bodies, ...items.map((it) => it.body)])];
      this.selectionChanged();
    } else if (this.pick === 'combine') {
      // A box adds tools (its first body becomes the target if there is none yet).
      for (const it of items) {
        if (!p.target) { p.target = it.body; this.slot = 'tools'; }
        else if (it.body !== p.target && !p.tools.includes(it.body)) p.tools.push(it.body);
      }
      this.render();
      this.app.renderTree();
    }
    this.update();
  }

  pickWhat() {
    return {
      regions: { regions: true },
      edges: { edges: true },
      faces: { faces: true },
      point: { faces: true },
      face: { faces: true },
      place: { faces: true, planes: true },
      plane: { faces: true, planes: true },
      bodies: { faces: true },
      combine: { faces: true },
      features: {},
      none: {},
    }[this.pick];
  }

  onMove(ev) {
    if (this.dragging()) { this.dragStage(ev); return; }
    const arrow = this.hoverArrows(ev);
    this.vp.renderer.domElement.style.cursor = !arrow && this.overShape(ev) ? 'move' : '';
    if (arrow) { this.hover = null; this.refreshPicks(); return; }
    if (this.pick === 'regions' || this.pick === 'none') return;
    if (this.gizmo) {
      const h = this.gizmo.hit(ev);
      this.gizmo.setHover(h);
      if (h) { this.hover = null; this.refreshPicks(); return; }
    }
    this.hover = this.vp.pick(ev, this.pickWhat());
    if (this.pick === 'face' && !this.hover?.flat) this.hover = null;
    if (this.pick === 'place' || this.pick === 'plane') {
      // Light up the origin plane a click would use.
      const name = this.hover?.kind === 'plane' ? this.hover.name : null;
      if (name !== this.hoverPlane) { this.hoverPlane = name; this.vp.showOriginPlanes(true, name); }
    }
    this.refreshPicks();
  }

  onLeave() { this.hover = null; this.refreshPicks(); }

  onClick(ev) {
    if (this.dragging()) { this.dragStage(ev); this.advanceStage(); return; }
    // A click on empty space (no body, profile or plane under it) is OK, once the step is valid.
    const what = this.pickWhat();
    if (!this.vp.pick(ev, { ...what, faces: true, regions: true })) {
      if (this.valid) this.ok();
      return;
    }
    const hit = this.vp.pick(ev, what);
    if (!hit) return;
    const p = this.params;
    if (this.pick === 'combine') {
      if (hit.kind === 'face') this.combinePick(hit.body);
      return;
    }
    if (this.pick === 'plane') {
      if (this.setSplitPlane(hit)) { this.render(); this.update(); }
      return;
    }
    if (this.pick === 'bodies') {
      if (hit.kind !== 'face') return;
      p.bodies = p.bodies.includes(hit.body) ? p.bodies.filter((b) => b !== hit.body) : [...p.bodies, hit.body];
      this.selectionChanged();
      this.update();
      return;
    }
    const same = (a, b) => Math.hypot(...a.map((v, i) => v - b[i])) < 1e-4;
    if (hit.kind === 'region') {
      const n = buildProfiles(this.app.featureById(p.sketch).params.entities).regions.length;
      let list = p.profiles === 'all' ? [] : [...p.profiles];
      list = list.includes(hit.index) ? list.filter((i) => i !== hit.index) : [...list, hit.index];
      p.profiles = list.length === 0 || list.length === n ? 'all' : list.sort((a, b) => a - b);
    } else if (hit.kind === 'edge') {
      const i = p.edges.findIndex((s) => same(s.m, hit.sig.m));
      if (i >= 0) p.edges.splice(i, 1); else p.edges.push(hit.sig);
    } else if (hit.kind === 'face' && this.pick === 'faces') {
      const i = p.faces.findIndex((s) => same(s.c, hit.sig.c));
      if (i >= 0) p.faces.splice(i, 1); else p.faces.push(hit.sig);
    } else if (hit.kind === 'face' && this.pick === 'face') {
      if (!hit.flat) { this.app.setStatus('Press Pull needs a flat face.', 'warn'); return; }
      p.face = hit.sig;
      p.normal = hit.sig.n;
      this.render();
    } else if (hit.kind === 'face' && this.placesPoint()) {
      this.placeOnFace(hit);
      if (this.stage === 'point') this.beginStage('size');
      this.render();
    } else if (hit.kind === 'plane' && this.pick === 'place') {
      // On an origin plane, snap to whole millimetres.
      const pl = PLANES[hit.name];
      p.point = hit.point.map((v) => Math.round(v));
      p.normal = pl.normal;
      p.xDir = pl.xDir;
      p.face = null;
      if (this.stage === 'point') this.beginStage('size');
      this.render();
    }
    this.update();
  }

  ok() {
    this.stop();
    this.app.commitFeature({ id: this.featureId, type: this.type, params: this.params }, this.index);
  }

  cancel() {
    this.stop();
    // A new import that is cancelled leaves nothing behind.
    if (this.type === 'stl' && this.index == null) delete this.app.meshes[this.params.mesh];
    this.app.endEdit();
  }
}

// Inspect > Measure: distance between two clicked points (snaps to edge ends).
export class MeasureTool {
  constructor(app) {
    this.app = app;
    this.vp = app.vp;
    this.points = [];
  }

  start() {
    this.vp.tool = this;
    this.render();
    this.app.setStatus('Click two points on faces or edges. Edge ends snap.');
    return true;
  }

  stop() { this.vp.tool = null; this.vp.setOverlay([]); }

  pointAt(ev) {
    const hit = this.vp.pick(ev, { edges: true, faces: true });
    if (!hit) return null;
    if (hit.kind === 'edge') {
      const tol = this.vp.unitsPerPixel() * 10;
      const ends = [hit.sig.s, hit.sig.e, hit.sig.m];
      const rc = this.vp.ray(ev).ray;
      for (const e of ends) {
        if (rc.distanceToPoint(new THREE.Vector3(...e)) < tol) return e;
      }
      return hit.sig.m;
    }
    return hit.point;
  }

  onMove(ev) {
    this.hover = this.pointAt(ev);
    this.overlay();
  }

  onClick(ev) {
    const p = this.pointAt(ev);
    if (!p) return;
    if (this.points.length === 2) this.points = [];
    this.points.push(p);
    this.render();
    this.overlay();
  }

  overlay() {
    const items = [{ kind: 'points', points: this.points, color: 0xff6a00, size: 10 }];
    if (this.hover) items.push({ kind: 'points', points: [this.hover], color: 0x6fb6ff, size: 8 });
    if (this.points.length === 2) items.push({ kind: 'polyline', points: this.points, color: 0xff6a00 });
    this.vp.setOverlay(items);
  }

  render() {
    const body = this.app.openPanel('Measure', [{ label: 'Close', primary: true, onClick: () => { this.stop(); this.app.endEdit(); } }]);
    const f = (v) => v.toFixed(3);
    if (this.points.length === 2) {
      const [a, b] = this.points;
      const d = b.map((v, i) => v - a[i]);
      body.append(
        el('div', { class: 'measure-result' }, `Distance: ${f(Math.hypot(...d))} mm`),
        el('div', { class: 'muted' }, `ΔX ${f(d[0])}   ΔY ${f(d[1])}   ΔZ ${f(d[2])}`),
      );
    } else {
      body.append(el('p', { class: 'muted' }, this.points.length ? 'Click the second point.' : 'Click the first point.'));
    }
  }
}
