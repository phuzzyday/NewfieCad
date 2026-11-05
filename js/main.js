// App controller: document state, undo/redo, toolbar, and switching between
// model mode, sketch mode and feature dialogs.

import { Viewport, VISUAL_STYLES } from './viewport.js';
import { ViewCube } from './viewcube.js';
import { Kernel } from './kernel.js';
import { SketchMode } from './sketch.js';
import { Selector } from './select.js';
import { loadSolver } from './solver.js';
import { FeatureDialog, MeasureTool, FEATURE_TYPES, PRIMITIVES, PATTERNS } from './features.js';
import { renderTimeline } from './timeline.js';
import { renderTree } from './tree.js';
import { download, openFile, saveAs, toSTL, to3MF, safeName, storeGet, storeSet } from './io.js';
import { parseSTL, encodeMesh } from './stl.js';
import { sketchFrame, faceFrame, toWorld, entityPolyline } from './profiles.js';
import { ICONS } from './icons.js';
import { el, field, num } from './ui.js';

const $ = (s) => document.querySelector(s);
// Storage key from when the app was called PrintCAD; kept so existing auto-saves still load.
const AUTOSAVE_KEY = 'printcad.autosave';
const STYLE_KEY = 'newfiecad.visualStyle';
// Project files say 'newfiecad'; files saved as 'printcad' still open.
const FORMATS = ['newfiecad', 'printcad'];
// Imported STLs above this many triangles are simplified, or cuts and joins get very slow.
const STL_LIMIT = 15000;

// Sketch placement for a picked flat face: an origin plane and offset when it is parallel to one.
function facePlane(hit) {
  const n = hit.normal, p = hit.point;
  let plane = null, offset = 0;
  if (Math.abs(n[2]) > 0.999) { plane = 'XY'; offset = p[2]; }
  else if (Math.abs(n[1]) > 0.999) { plane = 'XZ'; offset = -p[1]; }
  else if (Math.abs(n[0]) > 0.999) { plane = 'YZ'; offset = p[0]; }
  else return { plane: 'XY', offset: 0, frame: faceFrame(p, n) };
  return { plane, offset: Math.round(offset * 1000) / 1000 };
}

// bodyNames: names given to bodies by id. folders: [{ id, name, open }]; bodyFolder: body id ->
// folder id ('' for the top level). Bodies made from a body in a folder (copies, pattern and
// split results) show in the same folder until they are moved.
const newDoc = () => ({
  format: 'newfiecad', version: 1, name: 'Untitled', features: [], hiddenBodies: [], counters: {},
  bodyNames: {}, folders: [], bodyFolder: {},
});

const SOLID_TOOLS = [
  ['CREATE', [
    ['sketch', 'Create Sketch', () => app.startSketch()],
    ['extrude', 'Extrude (E)', () => app.startFeature('extrude')],
    ['revolve', 'Revolve', () => app.startFeature('revolve')],
    ['loft', 'Loft', () => app.startFeature('loft')],
    ['sweep', 'Sweep', () => app.startFeature('sweep')],
    ['hole', 'Hole (H)', () => app.startFeature('hole')],
    ['thread', 'Thread', () => app.startFeature('thread')],
    ['primitives', 'Primitives ▾', () => app.toggleRow('primitives')],
    ['pattern', 'Pattern ▾', () => app.toggleRow('pattern')],
    ['mirror', 'Mirror', () => app.startFeature('mirror')],
    ['stl', 'Insert STL', () => app.insertSTL()],
    ['step', 'Insert STEP', () => app.insertSTEP()],
  ]],
  ['MODIFY', [
    ['pressPull', 'Press Pull (Q)', () => app.startFeature('pressPull')],
    ['fillet', 'Fillet (F)', () => app.startFeature('fillet')],
    ['chamfer', 'Chamfer', () => app.startFeature('chamfer')],
    ['shell', 'Shell', () => app.startFeature('shell')],
    ['move', 'Move/Copy (M)', () => app.startFeature('move')],
    ['scale', 'Scale', () => app.startFeature('scale')],
    ['combine', 'Combine', () => app.startFeature('combine')],
    ['split', 'Split Body', () => app.startFeature('split')],
    ['remove', 'Remove (Delete)', () => app.startFeature('remove')],
  ]],
  ['INSPECT', [
    ['measure', 'Measure', () => app.startMeasure()],
  ]],
];

// Rows that open under the toolbar from a ▾ button and stay until closed or switched.
const TOOL_ROWS = { primitives: ['PRIMITIVES', PRIMITIVES], pattern: ['PATTERN', PATTERNS] };

// [icon, label, sketch tool] or [icon, label, null, sketch-mode method for one-shot actions]
const SKETCH_TOOLS = [
  ['CREATE', [
    ['line', 'Line (L)', 'line'],
    ['rect', '2-Point Rectangle (R)', 'rect'],
    ['crect', 'Center Rectangle', 'crect'],
    ['circle', 'Circle (C)', 'circle'],
    ['arc', '3-Point Arc (A)', 'arc'],
    ['polygon', 'Polygon', 'polygon'],
    ['slot', 'Slot', 'slot'],
  ]],
  ['MODIFY', [
    ['select', 'Select (S)', 'select'],
    ['dimension', 'Dimension (D)', 'dimension'],
    ['fillet', 'Fillet', 'fillet'],
    ['trim', 'Trim (T)', 'trim'],
    ['offset', 'Offset (O)', null, 'offsetSelected'],
    ['project', 'Project (P)', 'project'],
    ['construction', 'Construction (X)', null, 'toggleConstruction'],
  ]],
];

// Sketch constraints: select geometry first, then click one.
const CONSTRAINT_TOOLS = [
  ['coincident', 'Coincident'], ['horizontal', 'Horizontal'], ['vertical', 'Vertical'], ['parallel', 'Parallel'],
  ['perpendicular', 'Perpendicular'], ['tangent', 'Tangent'], ['equal', 'Equal'], ['concentric', 'Concentric'],
  ['midpoint', 'Midpoint'], ['fix', 'Fix'],
];

class App {
  constructor() {
    this.doc = newDoc();
    // Imported STL data by id. Kept outside the document so undo snapshots stay small;
    // saved with the project (only the ones it uses).
    this.meshes = {};
    this.undoStack = [];
    this.redoStack = [];
    this.bodies = [];
    this.errors = {};
    this.warnings = {};
    this.editingIndex = null;
    this.active = null;
    this.showOrigin = false;
    this.toolRow = null;

    this.vp = new Viewport($('#viewport'));
    new ViewCube($('#viewcube'), this.vp);
    this.selector = new Selector(this);
    this.vp.idleTool = this.selector;
    this.kernel = new Kernel((state, msg) => this.kernelStatus(state, msg));
    loadSolver().catch(() => this.setStatus('The sketch constraint solver could not load. Is the lib folder complete? Run fetch_libs.py.', 'warn'));

    this.bindChrome();
    this.setupApp();
    this.renderToolbar('solid');
    this.restoreAutosave().then(() => this.rebuild()).then(() => this.vp.home());
  }

  // All kernel builds go through here so imported STL data reaches the worker.
  build(request) { return this.kernel.build({ ...request, meshes: this.meshes }); }

  // ---------- helpers used by tools ----------

  toWorld(frame, p) { return toWorld(frame, p[0], p[1]); }

  polylineSegments(entity) {
    const pts = entityPolyline(entity);
    const out = [];
    for (let i = 0; i + 1 < pts.length; i++) out.push(pts[i], pts[i + 1]);
    return out;
  }

  newId(type) { return `${type}-${Math.random().toString(36).slice(2, 9)}`; }
  featureById(id) { return this.doc.features.find((f) => f.id === id); }
  hasBodies() { return this.bodies.length > 0; }
  sketchesBefore(stopAt) { return this.doc.features.slice(0, stopAt).filter((f) => f.type === 'sketch' && !f.suppressed); }
  lastSketchId(stopAt) { return this.sketchesBefore(stopAt).at(-1)?.id || null; }

  nextName(type) {
    const c = this.doc.counters;
    c[type] = (c[type] || 0) + 1;
    return `${FEATURE_TYPES[type].label}${c[type]}`;
  }

  // ---------- status / panel ----------

  setStatus(msg, level = 'info') {
    const s = $('#status');
    s.textContent = msg || '';
    s.className = level;
  }

  kernelStatus(state, msg) {
    const k = $('#kernel-state');
    if (state === 'ready') { $('#loading').hidden = true; k.textContent = 'Kernel ready'; k.className = 'ok'; }
    if (state === 'busy') { k.textContent = 'Computing…'; k.className = 'busy'; }
    if (state === 'idle') { k.textContent = 'Kernel ready'; k.className = 'ok'; }
    if (state === 'failed') this.setStatus(`Rebuild failed: ${msg}`, 'warn');
    if (state === 'error') { $('#loading').textContent = msg; k.textContent = 'Kernel error'; k.className = 'err'; }
  }

  openPanel(title, buttons) {
    $('#panel').hidden = false;
    $('#panel-title').textContent = title.toUpperCase();
    const body = $('#panel-body');
    body.replaceChildren();
    $('#panel-buttons').replaceChildren(...buttons.map((b) =>
      el('button', { class: `btn ${b.primary ? 'primary' : ''}`, onclick: b.onClick }, b.label)));
    return body;
  }

  closePanel() { $('#panel').hidden = true; }

  // ---------- building and display ----------

  async rebuild() {
    const res = await this.build({ features: this.doc.features });
    if (!res) return;
    this.applyResult(res);
    if (this.active) return;
    this.vp.setBodies(this.bodies, { hidden: new Set(this.doc.hiddenBodies) });
    this.shownBase = null;
    this.vp.setPreview(null);
    this.showSketches();
    this.selector.refresh();
  }

  applyResult(res) {
    this.bodies = this.named(res.bodies);
    this.errors = res.errors;
    this.warnings = res.warnings;
    this.renderSide();
    const failed = Object.keys(res.errors);
    if (failed.length && !this.active) {
      const f = this.featureById(failed[0]);
      this.setStatus(`${f?.name || 'A feature'} failed: ${res.errors[failed[0]]}`, 'warn');
      this.failureShown = $('#status').textContent;
    } else if (!failed.length && this.failureShown) {
      // Fixed, suppressed or deleted: the warning goes, unless something else has replaced it.
      if ($('#status').textContent === this.failureShown) this.setStatus('');
      this.failureShown = null;
    }
  }

  renderTree() { renderTree(this, $('#browser')); }

  // A body name clicked in the tree: picks it in a command that takes bodies, otherwise selects it.
  bodyClicked(id, add) {
    if (this.active) this.active.toggleBody?.(id);
    else this.selector.clickBody(id, add);
  }

  isBodySelected(id) {
    const a = this.active;
    if (a?.pick === 'combine') return a.params.target === id || a.params.tools.includes(id);
    if (a) return a.pick === 'bodies' && a.params.bodies.includes(id);
    return this.selector.hasBody(id);
  }

  renderSide() {
    this.renderTree();
    renderTimeline(this, $('#timeline'));
    this.updateStats();
  }

  updateStats() {
    const visible = this.bodies.filter((b) => !this.doc.hiddenBodies.includes(b.id));
    if (!visible.length) { $('#stats').textContent = ''; return; }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let vol = 0;
    for (const b of visible) {
      for (let i = 0; i < b.vertices.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], b.vertices[i + k]);
          max[k] = Math.max(max[k], b.vertices[i + k]);
        }
      }
      vol += b.volume || 0;
    }
    const size = max.map((v, k) => (v - min[k]).toFixed(1)).join(' × ');
    $('#stats').textContent = `Size ${size} mm · Volume ${(vol / 1000).toFixed(2)} cm³`;
  }

  // Sketches shown in the viewport. `extra` is the sketch being edited or picked from.
  showSketches(extra = null) {
    const stop = this.editingIndex ?? this.doc.features.length;
    const list = this.doc.features.slice(0, stop)
      .filter((f) => f.type === 'sketch' && !f.hidden && !f.suppressed)
      .map((f) => ({ frame: sketchFrame(f.params), entities: f.params.entities }));
    if (extra) list.push(extra);
    this.vp.setSketches(list);
  }

  // Build up to `stopAt` plus a draft feature; show the result as a live preview.
  // `fast` (while dragging) skips edge lines. The model before the step is only sent and
  // redrawn when it changed; bodies the step leaves alone reuse their meshes.
  async previewFeature(stopAt, draft, showBaseEdges, fast = false) {
    const res = await this.build({ features: this.doc.features, stopAt, draft, fast, haveBase: this.base?.key });
    if (!res || !this.active) return null;
    if (res.bodies) this.base = { key: res.baseKey, bodies: res.bodies };
    res.bodies = this.base.bodies;
    const hidden = new Set(this.doc.hiddenBodies);
    const shown = `${res.baseKey}|${!!res.preview}|${showBaseEdges}|${[...hidden]}`;
    if (res.preview) {
      const byId = new Map(res.bodies.map((b) => [b.id, b]));
      res.preview = res.preview.map((b) => (b.same ? byId.get(b.id) : b));
      // Hidden bodies stay hidden (and can't be picked) while a command is open.
      if (this.shownBase !== shown) this.vp.setBodies(res.bodies, { visible: false, showEdges: showBaseEdges, hidden });
      this.vp.setPreview(res.preview.filter((b) => !hidden.has(b.id)));
    } else {
      if (this.shownBase !== shown) this.vp.setBodies(res.bodies, { hidden });
      this.vp.setPreview(null);
    }
    this.shownBase = shown;
    return res;
  }

  async showBase(stopAt) {
    const res = await this.build({ features: this.doc.features, stopAt });
    if (!res || !this.active) return;
    this.vp.setBodies(res.bodies, { hidden: new Set(this.doc.hiddenBodies) });
    this.shownBase = null;
    this.vp.setPreview(null);
  }

  // ---------- editing ----------

  stopActive() {
    if (!this.active) return;
    this.active.stop?.();
    this.active = null;
  }

  startSketch() {
    this.stopActive();
    // A selected flat face goes straight into a sketch on it.
    const face = this.selector.take().find((it) => it.kind === 'face' && it.flat);
    const onFace = face && facePlane(face);
    if (onFace) { this.beginSketch(null, { ...onFace, entities: [] }); return; }
    this.vp.setOverlay([]);
    this.editingIndex = this.doc.features.length;
    this.vp.showOriginPlanes(true);
    this.setStatus('Select a plane, or a flat face that is parallel to one. Esc cancels.');
    let hoverName = null;
    const picker = {
      stop: () => { this.vp.tool = null; this.vp.showOriginPlanes(this.showOrigin); this.vp.setOverlay([]); },
      onMove: (ev) => {
        const hit = this.vp.pick(ev, { planes: true, faces: true });
        const name = hit?.kind === 'plane' ? hit.name : null;
        if (name !== hoverName) { hoverName = name; this.vp.showOriginPlanes(true, name); }
        this.vp.setOverlay(hit?.kind === 'face' ? [{ kind: 'face', body: hit.body, group: hit.group, color: 0x6fb6ff }] : []);
      },
      onClick: (ev) => {
        const hit = this.vp.pick(ev, { planes: true, faces: true });
        if (!hit) return;
        let at = { plane: hit.name, offset: 0 };
        if (hit.kind === 'face') {
          if (!hit.flat) { this.setStatus('Sketches go on flat faces.', 'warn'); return; }
          at = facePlane(hit);
        }
        picker.stop();
        this.beginSketch(null, { ...at, entities: [] });
      },
    };
    this.active = picker;
    this.vp.tool = picker;
    this.openPanel('Create Sketch', [{ label: 'Cancel', onClick: () => this.endEdit() }])
      .append(el('p', { class: 'muted' }, 'Click an origin plane or a flat face in the view.'));
    this.renderSide();
  }

  beginSketch(index, params) {
    this.stopActive();
    this.editingIndex = index ?? this.doc.features.length;
    const mode = new SketchMode(this, {
      params,
      onFinish: (p) => {
        this.active = null;
        if (index == null && !p.entities.length) { this.endEdit(); return; }
        this.commitFeature({ id: index == null ? this.newId('sketch') : this.doc.features[index].id, type: 'sketch', params: p }, index);
      },
      onCancel: () => { this.active = null; this.endEdit(); },
    });
    this.active = mode;
    this.renderToolbar('sketch');
    this.showBase(this.editingIndex);
    mode.start();
    this.renderSide();
  }

  startFeature(type) {
    this.stopActive();
    this.closePanel();
    const dlg = new FeatureDialog(this, { type, preselect: this.selector.take() });
    this.active = dlg;
    this.editingIndex = this.doc.features.length;
    if (!dlg.start()) return;
    this.renderSide();
  }

  // Clicking a ▾ button again closes its row; another ▾ button switches to its row.
  toggleRow(name) {
    this.toolRow = this.toolRow === name ? null : name;
    this.renderToolbar('solid');
  }

  startMeasure() {
    this.stopActive();
    this.selector.take();
    this.active = new MeasureTool(this);
    this.active.start();
  }

  editFeature(i) {
    const f = this.doc.features[i];
    if (!f) return;
    this.stopActive();
    if (f.type === 'sketch') { this.beginSketch(i, f.params); return; }
    const dlg = new FeatureDialog(this, { type: f.type, index: i, params: f.params });
    this.active = dlg;
    this.editingIndex = i;
    dlg.start();
    this.renderSide();
  }

  commitFeature(feature, index) {
    this.pushUndo();
    if (index == null) {
      feature.name = feature.type === 'stl' || feature.type === 'step' ? feature.params.name.replace(/\.(stl|ste?p)$/i, '') : this.nextName(feature.type);
      // The sketches a solid was made from are hidden, as in Fusion.
      const p = feature.params;
      const used = feature.type === 'extrude' || feature.type === 'revolve' ? [p.sketch]
        : feature.type === 'loft' ? p.sections.map((s) => s.sketch)
          : feature.type === 'sweep' ? [p.profile?.sketch, p.path?.sketch] : [];
      for (const id of used) {
        const sk = this.featureById(id);
        if (sk) sk.hidden = true;
      }
      this.doc.features.push(feature);
    } else {
      this.doc.features[index] = { ...this.doc.features[index], params: feature.params };
    }
    this.save();
    this.endEdit();
  }

  endEdit() {
    this.stopActive();
    this.editingIndex = null;
    this.vp.tool = null;
    this.vp.setOverlay([]);
    this.vp.showOriginPlanes(this.showOrigin);
    this.closePanel();
    this.renderToolbar('solid');
    this.setStatus('');
    this.rebuild();
  }

  // ---------- document operations ----------

  pushUndo() {
    this.undoStack.push(JSON.stringify(this.doc));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  undo() {
    if (this.active || !this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(this.undoStack.pop());
    this.save();
    this.rebuild();
  }

  redo() {
    if (this.active || !this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.doc));
    this.doc = JSON.parse(this.redoStack.pop());
    this.save();
    this.rebuild();
  }

  // Adds a Remove step to the timeline for these bodies, without opening a dialog.
  removeBodies(ids) {
    if (!ids.length) return;
    this.stopActive();
    this.selector.take();
    this.commitFeature({ id: this.newId('remove'), type: 'remove', params: { bodies: ids } });
  }

  // Delete key: remove the selected bodies.
  // Ctrl+C keeps the bodies of whatever is selected; Ctrl+V opens Move/Copy on copies of
  // them, sitting on the originals, ready to drag into place.
  copyBodies() {
    const ids = [...new Set(this.selector.items.map((it) => it.body))];
    if (!ids.length) { this.setStatus('Select a body (or a face or edge of it) to copy.', 'warn'); return; }
    this.clipboard = ids;
    this.setStatus(`Copied ${ids.length === 1 ? 'a body' : `${ids.length} bodies`}. Press Ctrl+V to paste.`);
  }

  pasteBodies() {
    const ids = (this.clipboard || []).filter((id) => this.bodies.some((b) => b.id === id));
    if (!ids.length) { this.setStatus(this.clipboard ? 'The copied bodies are gone.' : 'Nothing copied yet: select a body and press Ctrl+C.', 'warn'); return; }
    this.selector.set(ids.map((body) => ({ kind: 'body', body })));
    this.startFeature('move');
    if (!(this.active instanceof FeatureDialog)) return;
    this.active.params.copy = true;
    this.active.render();
    this.active.update();
    this.setStatus('Pasted on top of the original: drag an arrow or type the distances, then OK.');
  }

  deleteSelection() {
    const ids = this.selector.items.filter((it) => it.kind === 'body').map((it) => it.body);
    if (ids.length) this.removeBodies(ids);
    else if (this.selector.items.length) this.setStatus('To remove a body, select the whole body (middle-click or double-click it), then press Delete.', 'warn');
  }

  deleteFeature(i) {
    this.stopActive();
    this.pushUndo();
    this.doc.features.splice(i, 1);
    this.save();
    this.endEdit();
  }

  toggleSuppress(i) {
    this.pushUndo();
    const f = this.doc.features[i];
    f.suppressed = !f.suppressed;
    this.save();
    this.rebuild();
  }

  // ---------- body names and folders ----------

  // Bodies with the names the user gave them.
  named(bodies) {
    const names = this.doc.bodyNames || {};
    return bodies.map((b) => (names[b.id] ? { ...b, name: names[b.id] } : b));
  }

  // Change the document as one undo step, then save and redraw the tree.
  changeDoc(fn) {
    this.pushUndo();
    fn(this.doc);
    this.save();
    this.renderSide();
  }

  renameBody(id, name) {
    name = name.trim();
    if (!name) return;
    this.changeDoc((d) => { d.bodyNames = { ...d.bodyNames, [id]: name }; });
    this.bodies = this.named(this.bodies);
    this.renderSide();
  }

  // The folder a body is in: its own, or that of the body it was made from.
  folderOf(id) {
    const d = this.doc, exists = (fid) => d.folders.some((f) => f.id === fid);
    if (id in d.bodyFolder) return exists(d.bodyFolder[id]) ? d.bodyFolder[id] : null;
    let best = null, bestLen = 0;
    for (const [src, fid] of Object.entries(d.bodyFolder)) {
      if (fid && exists(fid) && src.length > bestLen && `#${id}#`.includes(`#${src}#`)) { best = fid; bestLen = src.length; }
    }
    return best;
  }

  newFolder(bodies = []) {
    let n = 1;
    while (this.doc.folders.some((f) => f.name === `Folder ${n}`)) n++;
    const f = { id: this.newId('folder'), name: `Folder ${n}`, open: true };
    this.changeDoc((d) => {
      d.folders = [...d.folders, f];
      d.bodyFolder = { ...d.bodyFolder, ...Object.fromEntries(bodies.map((id) => [id, f.id])) };
    });
    return f.id;
  }

  // folderId null: back to the top level.
  moveToFolder(ids, folderId) {
    this.changeDoc((d) => { d.bodyFolder = { ...d.bodyFolder, ...Object.fromEntries(ids.map((id) => [id, folderId || ''])) }; });
  }

  renameFolder(fid, name) {
    name = name.trim();
    if (!name) return;
    this.changeDoc((d) => { d.folders = d.folders.map((f) => (f.id === fid ? { ...f, name } : f)); });
  }

  // The folder goes; its bodies stay, at the top level.
  deleteFolder(fid) {
    this.changeDoc((d) => {
      d.folders = d.folders.filter((f) => f.id !== fid);
      d.bodyFolder = Object.fromEntries(Object.entries(d.bodyFolder).filter(([, v]) => v !== fid));
    });
  }

  // Open or closed is remembered, but isn't an undo step.
  setFolderOpen(fid, open) {
    const f = this.doc.folders.find((x) => x.id === fid);
    if (!f || f.open === open) return;
    f.open = open;
    this.save();
  }

  folderBodies(fid) { return this.bodies.filter((b) => this.folderOf(b.id) === fid).map((b) => b.id); }

  // Hide every body in the folder, or show them all if they are all hidden.
  toggleFolder(fid) {
    const ids = this.folderBodies(fid);
    const h = this.doc.hiddenBodies;
    const allHidden = ids.every((id) => h.includes(id));
    this.doc.hiddenBodies = allHidden ? h.filter((x) => !ids.includes(x)) : [...new Set([...h, ...ids])];
    this.save();
    if (!this.active) {
      this.vp.setBodies(this.bodies, { hidden: new Set(this.doc.hiddenBodies) });
      this.shownBase = null;
      this.selector.refresh();
    }
    this.renderSide();
  }

  // Select a folder's bodies, or add them to the current command's picks.
  selectFolder(fid) {
    const ids = this.folderBodies(fid).filter((id) => !this.doc.hiddenBodies.includes(id));
    const a = this.active;
    if (a?.pick === 'bodies') {
      a.params.bodies = [...new Set([...a.params.bodies, ...ids])];
      a.selectionChanged();
      a.update();
    } else if (!a) this.selector.set(ids.map((body) => ({ kind: 'body', body })));
    this.renderSide();
  }

  // Bodies a tree action applies to: the selected ones if the clicked body is among them.
  bodiesFor(id) {
    const sel = this.selector.items.filter((it) => it.kind === 'body').map((it) => it.body);
    return sel.includes(id) ? sel : [id];
  }

  renameFeature(i) {
    const f = this.doc.features[i];
    const name = prompt('New name', f.name);
    if (!name || name === f.name) return;
    this.pushUndo();
    f.name = name.trim();
    this.save();
    this.renderSide();
  }

  renameDocument(name) {
    this.doc.name = name.trim() || 'Untitled';
    this.save();
  }

  toggleBody(id) {
    const h = this.doc.hiddenBodies;
    this.doc.hiddenBodies = h.includes(id) ? h.filter((x) => x !== id) : [...h, id];
    this.save();
    if (!this.active) {
      this.vp.setBodies(this.bodies, { hidden: new Set(this.doc.hiddenBodies) });
      this.shownBase = null;
      this.selector.refresh();
    }
    this.renderSide();
  }

  toggleSketch(i) {
    const f = this.doc.features[i];
    f.hidden = !f.hidden;
    this.save();
    if (!this.active) this.showSketches();
    this.renderSide();
  }

  toggleOrigin() {
    this.showOrigin = !this.showOrigin;
    this.vp.showOriginPlanes(this.showOrigin);
    this.renderSide();
  }

  // ---------- files ----------

  // The document plus the STL data it uses, as saved to a file or the auto-save.
  serialize(space) {
    const meshes = {};
    for (const f of this.doc.features) {
      if (f.type === 'stl' && this.meshes[f.params.mesh]) meshes[f.params.mesh] = this.meshes[f.params.mesh];
      if (f.type === 'step' && this.meshes[f.params.data]) meshes[f.params.data] = this.meshes[f.params.data];
    }
    return JSON.stringify({ ...this.doc, meshes }, null, space);
  }

  // Load a saved document; its STL data joins the store.
  loadDoc(data) {
    const { meshes, ...doc } = data;
    Object.assign(this.meshes, meshes || {});
    this.doc = { ...newDoc(), ...doc, format: 'newfiecad' };
  }

  save() {
    const text = this.serialize();
    storeSet(AUTOSAVE_KEY, text).catch(() => {
      try { localStorage.setItem(AUTOSAVE_KEY, text); } catch { /* storage unavailable */ }
    });
  }

  async restoreAutosave() {
    try {
      // Older versions saved to localStorage.
      const text = (await storeGet(AUTOSAVE_KEY).catch(() => null)) || localStorage.getItem(AUTOSAVE_KEY);
      const saved = JSON.parse(text || 'null');
      if (FORMATS.includes(saved?.format) && saved.features?.length) {
        this.loadDoc(saved);
        this.setStatus('Restored your last session. File > New starts over.');
      }
    } catch { /* ignore */ }
  }

  newDocument() {
    if (this.doc.features.length && !confirm('Start a new design? Unsaved changes will be lost.')) return;
    this.stopActive();
    this.pushUndo();
    this.doc = newDoc();
    this.save();
    this.endEdit();
  }

  saveFile() {
    download(`${safeName(this.doc.name)}.newfiecad.json`, this.serialize(1), 'application/json');
    this.setStatus('Project saved to your downloads.');
  }

  // `file` comes from the system when the installed app opens a file; otherwise ask for one.
  async openProject(file = null) {
    file ??= await openFile('.json,application/json');
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!FORMATS.includes(data.format) || !Array.isArray(data.features)) throw new Error('Not a project file');
      this.stopActive();
      this.pushUndo();
      this.loadDoc(data);
      this.save();
      this.endEdit();
      setTimeout(() => this.vp.fit(), 600);
      this.setStatus(`Opened ${file.name}`);
    } catch (e) {
      this.setStatus(`Could not open that file: ${e.message}`, 'warn');
    }
  }

  // ---------- installable app ----------

  // Offline support, the Install button, and files opened with the installed app.
  setupApp() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* offline install not available here */ });
    }
    const btn = $('#btn-install');
    let prompt = null;
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); prompt = e; btn.hidden = false; });
    window.addEventListener('appinstalled', () => { btn.hidden = true; this.setStatus('NewfieCad is installed. Find it in your apps menu.'); });
    btn.onclick = async () => {
      if (!prompt) return;
      prompt.prompt();
      await prompt.userChoice;
      prompt = null;
      btn.hidden = true;
    };
    // Double-clicking an .stl or a project file opens it here.
    if ('launchQueue' in window) {
      window.launchQueue.setConsumer(async ({ files }) => {
        for (const handle of files || []) {
          const file = await handle.getFile();
          if (/\.stl$/i.test(file.name)) await this.insertSTL(file);
          else if (/\.ste?p$/i.test(file.name)) await this.insertSTEP(file);
          else await this.openProject(file);
        }
      });
    }
  }

  // ---------- STL import ----------

  async insertSTL(file = null) {
    if (this.active) { this.setStatus('Finish or cancel the current command first.', 'warn'); return; }
    file ??= await openFile('.stl,model/stl');
    if (!file) return;
    let mesh;
    try {
      mesh = parseSTL(await file.arrayBuffer());
    } catch (e) {
      this.setStatus(`Could not read ${file.name}: ${e.message}`, 'warn');
      return;
    }
    const tris = mesh.indices.length / 3;
    let origTris = null;
    if (tris > STL_LIMIT) {
      const target = await this.askSimplify(file.name, tris);
      if (!target) { this.endEdit(); return; }
      try {
        mesh = await this.simplify(mesh, target);
      } catch (e) {
        this.endEdit();
        this.setStatus(`Simplifying failed: ${e.message}`, 'warn');
        return;
      }
      origTris = tris;
      this.endEdit();
    }
    const id = this.newId('mesh');
    this.meshes[id] = encodeMesh(mesh);
    const dlg = new FeatureDialog(this, {
      type: 'stl',
      params: {
        mesh: id, name: file.name, tris: mesh.indices.length / 3, origTris,
        units: 'mm', sx: 1, sy: 1, sz: 1, center: true, op: 'new',
      },
    });
    this.stopActive();
    this.active = dlg;
    this.editingIndex = this.doc.features.length;
    dlg.start();
    this.renderSide();
  }

  // ---------- STEP import ----------

  // A STEP file (from Fusion, FreeCAD, Onshape...) comes in as exact solids, without history.
  async insertSTEP(file = null) {
    if (this.active) { this.setStatus('Finish or cancel the current command first.', 'warn'); return; }
    file ??= await openFile('.step,.stp');
    if (!file) return;
    const id = this.newId('step');
    this.meshes[id] = { step: await file.text() };
    const dlg = new FeatureDialog(this, { type: 'step', params: { data: id, name: file.name, center: false, op: 'new' } });
    this.stopActive();
    this.active = dlg;
    this.editingIndex = this.doc.features.length;
    dlg.start();
    this.renderSide();
  }

  // Ask how far to simplify a big STL. Resolves with the triangle count, or null.
  askSimplify(name, tris) {
    return new Promise((resolve) => {
      const done = (v) => { this.active = { cancel: () => {} }; resolve(v); };
      this.active = { cancel: () => { this.endEdit(); resolve(null); } };
      const n = tris.toLocaleString();
      const body = this.openPanel('Simplify STL', [
        { label: 'Simplify', primary: true, onClick: () => { const v = Math.round(num(box.value)); if (v >= 100) done(Math.min(v, tris)); } },
        { label: 'Cancel', onClick: () => done(null) },
      ]);
      const box = el('input', { type: 'text', value: STL_LIMIT });
      body.append(
        el('p', {}, `${name} has ${n} triangles. Above about ${STL_LIMIT.toLocaleString()}, cutting or joining it gets very slow.`),
        el('p', { class: 'muted' }, 'Simplifying merges triangles where the surface is flattest. Fine detail and smooth curves get coarser.'),
        field('Simplify to (triangles)', box),
      );
    });
  }

  // Simplify in a worker; shows progress in the panel.
  simplify(mesh, target) {
    const body = this.openPanel('Simplify STL', []);
    const msg = el('p', {}, 'Simplifying… 0%');
    body.append(msg);
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./simplify-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (ev) => {
        const d = ev.data;
        if (d.type === 'progress') { msg.textContent = `Simplifying… ${Math.round(d.value * 100)}%`; return; }
        w.terminate();
        if (d.type === 'done') resolve({ positions: d.positions, indices: d.indices });
        else reject(new Error(d.error));
      };
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker failed')); };
      w.postMessage({ positions: mesh.positions, indices: mesh.indices, target });
    });
  }

  // Fine-quality meshes of all bodies, built once per design state.
  exportMeshes() {
    const key = JSON.stringify(this.doc.features);
    if (this.exportCache?.key !== key) {
      this.exportCache = { key, promise: this.build({ features: this.doc.features, export: true }) };
    }
    return this.exportCache.promise;
  }

  // Save the given bodies as one file, asking for its name.
  async exportBodies(kind, ids, suggested) {
    if (kind === 'step') return this.exportStep(ids, suggested);
    const meshes = this.exportMeshes();
    try {
      const saved = await saveAs(safeName(suggested), `.${kind}`, async () => {
        const res = await meshes;
        if (!res) { this.exportCache = null; throw new Error('Export was interrupted. Try again.'); }
        const bodies = this.named(res.bodies.filter((b) => ids.includes(b.id)));
        return kind === 'stl' ? toSTL(bodies) : to3MF(bodies);
      });
      if (saved) this.setStatus(`Saved ${saved}.`);
      return saved;
    } catch (e) {
      this.setStatus(`Export failed: ${e.message}`, 'warn');
      return null;
    }
  }

  // STEP keeps the exact shapes, so the bodies can go back into Fusion or other CAD.
  async exportStep(ids, suggested) {
    try {
      const saved = await saveAs(safeName(suggested), '.step', async () => {
        const res = await this.build({ features: this.doc.features, stepIds: ids, bodyNames: this.doc.bodyNames });
        if (!res?.step) throw new Error('Export was interrupted. Try again.');
        return new Uint8Array(res.step);
      });
      if (saved) this.setStatus(`Saved ${saved}.`);
      return saved;
    } catch (e) {
      this.setStatus(`Export failed: ${e.message}`, 'warn');
      return null;
    }
  }

  // Export the selected bodies, or the only visible body; otherwise let the user choose.
  exportMesh(kind) {
    if (this.active) { this.setStatus('Finish or cancel the current command first.', 'warn'); return; }
    const visible = this.bodies.filter((b) => !this.doc.hiddenBodies.includes(b.id));
    const selected = [...new Set(this.selector.items.map((it) => it.body))].filter((id) => this.bodies.some((b) => b.id === id));
    const ids = selected.length ? selected : visible.length === 1 ? [visible[0].id] : [];
    if (!ids.length && !visible.length) { this.setStatus('There are no visible bodies to export.', 'warn'); return; }
    if (ids.length === 1) { this.exportBodies(kind, ids, this.bodies.find((b) => b.id === ids[0]).name); return; }
    if (ids.length && kind !== 'stl') { this.exportBodies(kind, ids, this.doc.name); return; }
    this.exportPanel(kind, ids.length ? ids : visible.map((b) => b.id));
  }

  // STL holds one body per file, so each body gets its own Save button.
  // 3MF keeps bodies as separate objects in one file, so it gets tick boxes.
  exportPanel(kind, ids) {
    const close = () => this.endEdit();
    this.active = { cancel: close };
    const body = this.openPanel(`Export ${kind.toUpperCase()}`, [{ label: 'Close', onClick: close }]);
    const bodies = ids.map((id) => this.bodies.find((b) => b.id === id)).reverse(); // newest first
    if (kind === 'stl') {
      body.append(el('p', { class: 'muted' }, 'An STL file holds one body. Save each body you want:'));
      for (const b of bodies) {
        const note = el('div', { class: 'muted' });
        const btn = el('button', { class: 'btn small' }, 'Save STL…');
        btn.addEventListener('click', async () => {
          const f = await this.exportBodies('stl', [b.id], b.name);
          if (f) note.textContent = `Saved as ${f}`;
        });
        body.append(el('div', { class: 'export-row' }, el('span', {}, b.name), btn, note));
      }
    } else {
      body.append(el('p', { class: 'muted' }, kind === 'step'
        ? 'Tick the bodies to put in the file. Each one stays a separate body in Fusion or other CAD.'
        : 'Tick the bodies to put in the file. Each one stays a separate object in the slicer.'));
      const boxes = bodies.map((b) => [b, el('input', { type: 'checkbox' })]);
      body.append(el('div', { class: 'feature-list' }, ...boxes.map(([b, box]) => el('label', { class: 'check' }, box, b.name))));
      const go = el('button', { class: 'btn primary' }, 'Save 3MF…');
      go.addEventListener('click', () => {
        const chosen = boxes.filter(([, box]) => box.checked).map(([b]) => b);
        if (!chosen.length) { this.setStatus('Tick at least one body.', 'warn'); return; }
        this.exportBodies(kind, chosen.map((b) => b.id), chosen.length === 1 ? chosen[0].name : this.doc.name);
      });
      body.append(go);
    }
    if (kind !== 'step') this.exportMeshes(); // start the fine mesh while the user chooses
  }

  // ---------- chrome ----------

  renderToolbar(mode) {
    const bar = $('#toolbar');
    bar.replaceChildren();
    const tabs = el('div', { class: 'tabs' },
      el('span', { class: `tab ${mode === 'solid' ? 'active' : ''}` }, 'SOLID'),
      el('span', { class: `tab ${mode === 'sketch' ? 'active' : ''}` }, 'SKETCH'));
    bar.append(tabs);
    const groups = el('div', { class: 'groups' });
    if (mode === 'solid') {
      for (const [title, tools] of SOLID_TOOLS) {
        groups.append(el('div', { class: 'group' },
          el('div', { class: 'group-tools' }, ...tools.map(([icon, label, fn]) =>
            el('button', { class: `tool ${icon === this.toolRow ? 'active' : ''}`, title: label, onclick: fn, html: ICONS[icon] + `<span>${label.replace(/ \(.\)$/, '')}</span>` }))),
          el('div', { class: 'group-title' }, title)));
      }
      if (this.toolRow) {
        const [title, types] = TOOL_ROWS[this.toolRow];
        bar.append(groups, el('div', { id: 'toolrow' },
          el('span', { class: 'row-title' }, title),
          ...types.map((t) => el('button', {
            class: 'tool', title: FEATURE_TYPES[t].label, onclick: () => this.startFeature(t),
            html: ICONS[FEATURE_TYPES[t].icon] + `<span>${FEATURE_TYPES[t].label}</span>`,
          })),
          el('button', { class: 'row-close', title: 'Close this row', onclick: () => this.toggleRow(null) }, '×')));
        return;
      }
    } else {
      for (const [title, tools] of SKETCH_TOOLS) {
        groups.append(el('div', { class: 'group' },
          el('div', { class: 'group-tools' }, ...tools.map(([icon, label, t, action]) =>
            el('button', {
              class: 'tool', title: label, 'data-sketch-tool': t || undefined,
              onclick: () => (t ? this.active?.setTool?.(t) : this.active?.[action]?.()),
              html: ICONS[icon] + `<span>${label.replace(/ \(.\)$/, '')}</span>`,
            }))),
          el('div', { class: 'group-title' }, title)));
      }
      groups.append(el('div', { class: 'group' },
        el('div', { class: 'group-tools constraints' }, ...CONSTRAINT_TOOLS.map(([type, label]) =>
          el('button', { class: 'tool small', title: `${label}: select geometry first`, onclick: () => this.active?.applyConstraint?.(type), html: ICONS[`k_${type}`] + `<span>${label}</span>` }))),
        el('div', { class: 'group-title' }, 'CONSTRAIN')));
      groups.append(el('div', { class: 'group' },
        el('div', { class: 'group-tools' },
          el('button', { class: 'tool finish', title: 'Finish Sketch', onclick: () => this.active?.finish?.(), html: ICONS.finish + '<span>Finish Sketch</span>' })),
        el('div', { class: 'group-title' }, 'FINISH')));
      this.active?.tool && document.querySelectorAll('[data-sketch-tool]').forEach((b) => b.classList.toggle('active', b.dataset.sketchTool === this.active.tool));
    }
    bar.append(groups);
  }

  bindChrome() {
    $('#btn-new').onclick = () => this.newDocument();
    $('#btn-open').onclick = () => this.openProject();
    $('#btn-save').onclick = () => this.saveFile();
    $('#btn-stl').onclick = () => this.exportMesh('stl');
    $('#btn-3mf').onclick = () => this.exportMesh('3mf');
    $('#btn-step').onclick = () => this.exportMesh('step');
    $('#btn-undo').onclick = () => this.undo();
    $('#btn-redo').onclick = () => this.redo();
    $('#btn-home').onclick = () => this.vp.home();
    $('#btn-fit').onclick = () => this.vp.fit();
    const ortho = $('#btn-ortho');
    ortho.onclick = () => {
      this.vp.setOrtho(!this.vp.useOrtho);
      ortho.textContent = this.vp.useOrtho ? 'Orthographic' : 'Perspective';
    };
    // Visual style, remembered between visits.
    const style = $('#visual-style');
    style.append(...VISUAL_STYLES.map(([v, l]) => el('option', { value: v }, l)));
    let saved = null;
    try { saved = localStorage.getItem(STYLE_KEY); } catch { /* storage unavailable */ }
    if (VISUAL_STYLES.some(([v]) => v === saved)) this.vp.style = saved;
    style.value = this.vp.style;
    style.onchange = () => {
      this.vp.setStyle(style.value);
      try { localStorage.setItem(STYLE_KEY, style.value); } catch { /* storage unavailable */ }
      style.blur();
    };
    $('#btn-undo').innerHTML = ICONS.undo;
    $('#btn-redo').innerHTML = ICONS.redo;
    $('#btn-home').innerHTML = ICONS.home;
    $('#btn-fit').innerHTML = ICONS.fit;

    // Toolbar buttons shouldn't keep focus, or Enter / Space would press them again.
    document.addEventListener('mousedown', (e) => {
      if (e.target.closest('#toolbar button, #topbar button, .view-buttons button, #timeline button')) e.preventDefault();
    });

    window.addEventListener('keydown', (e) => {
      if (e.target.closest?.('input, select, textarea')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); this.saveFile(); return; }
      if (e.key === 'F6') { e.preventDefault(); this.vp.fit(); return; }
      if (this.active instanceof SketchMode) return; // sketch mode handles its own keys
      // Ctrl+Z undoes; Ctrl+Y or Ctrl+Shift+Z redoes.
      if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.undo(); return; }
      if (ctrl && (e.key.toLowerCase() === 'y' || e.key.toLowerCase() === 'z')) { e.preventDefault(); this.redo(); return; }
      if (e.key === 'Escape' && this.active) { this.active.cancel ? this.active.cancel() : this.endEdit(); return; }
      if (e.key === 'Escape') { this.selector.clear(); return; }
      if (e.key === 'Enter' && this.active?.ok) { this.active.ok(); return; }
      if (ctrl && !this.active && e.key.toLowerCase() === 'c') { e.preventDefault(); this.copyBodies(); return; }
      if (ctrl && !this.active && e.key.toLowerCase() === 'v') { e.preventDefault(); this.pasteBodies(); return; }
      if (ctrl || e.altKey || this.active) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelection(); return; }
      const keys = { e: 'extrude', f: 'fillet', h: 'hole', m: 'move', q: 'pressPull' };
      if (keys[e.key]) this.startFeature(keys[e.key]);
    });
  }
}

const app = new App();
window.newfiecad = app;
