// Selecting outside of commands: click a face or edge, double-click for the whole
// body, Ctrl+click to add or remove, drag a box for bodies. The next command
// starts with whatever is selected.

const SELECT = 0x0a6cff;
const HOVER = 0x6fb6ff;
const NAMES = { body: ['body', 'bodies'], face: ['face', 'faces'], edge: ['edge', 'edges'] };

const keyOf = (it) => (it.kind === 'body' ? `body:${it.body}` : `${it.kind}:${it.body}:${it.group}`);

export class Selector {
  constructor(app) {
    this.app = app;
    this.vp = app.vp;
    this.items = [];
    this.hover = null;
  }

  has(it) { return this.items.some((x) => keyOf(x) === keyOf(it)); }

  hasBody(id) { return this.items.some((x) => x.kind === 'body' && x.body === id); }

  set(items) {
    this.items = items;
    this.changed();
  }

  // Ctrl adds or removes; a plain pick replaces the selection.
  pickItem(it, add) {
    if (!add) this.set([it]);
    else if (this.has(it)) this.set(this.items.filter((x) => keyOf(x) !== keyOf(it)));
    else this.set([...this.items, it]);
  }

  clear() { if (this.items.length) this.set([]); }

  // Hand the selection to a command that is starting.
  take() {
    const items = this.items;
    this.items = [];
    this.hover = null;
    return items;
  }

  // After a rebuild, find the selected items again on the new bodies.
  refresh() {
    const ids = new Set(this.vp.bodyData.filter((b) => b.mesh).map((b) => b.id));
    this.items = this.items.flatMap((it) => {
      if (it.kind === 'body') return ids.has(it.body) ? [it] : [];
      if (it.kind === 'face') {
        const f = this.vp.findFace(it.sig);
        return f && ids.has(f.body) ? [{ ...it, ...f }] : [];
      }
      const points = this.vp.findEdge(it.sig);
      return points ? [{ ...it, points }] : [];
    });
    this.hover = null;
    this.draw();
  }

  changed() {
    this.draw();
    this.app.setStatus(this.describe());
    this.app.renderTree();
  }

  describe() {
    const parts = Object.entries(NAMES).map(([kind, [one, many]]) => {
      const n = this.items.filter((x) => x.kind === kind).length;
      return n ? `${n} ${n === 1 ? one : many}` : '';
    }).filter(Boolean);
    return parts.length ? `Selected: ${parts.join(', ')}. Start a command to use them, or press Esc to clear.` : '';
  }

  draw() {
    if (this.vp.tool) return; // a command owns the highlights
    const items = [];
    const add = (it, color) => {
      if (it.kind === 'body') items.push({ kind: 'body', body: it.body, color });
      else if (it.kind === 'face') items.push({ kind: 'face', body: it.body, group: it.group, color });
      else items.push({ kind: 'edge', points: it.points, color });
    };
    this.items.forEach((it) => add(it, SELECT));
    if (this.hover && !this.has(this.hover)) add(this.hover, HOVER);
    this.vp.setOverlay(items);
  }

  // ---------- viewport events (used when no command is running) ----------

  onMove(ev) {
    this.hover = this.vp.pick(ev, { edges: true, faces: true });
    this.draw();
  }

  onLeave() { this.hover = null; this.draw(); }

  onClick(ev) {
    const hit = this.vp.pick(ev, { edges: true, faces: true });
    const add = ev.ctrlKey || ev.metaKey;
    if (hit) this.pickItem(hit, add);
    else if (!add) this.clear();
  }

  onDblClick(ev) {
    const hit = this.vp.pick(ev, { faces: true });
    if (!hit) return;
    const body = { kind: 'body', body: hit.body };
    if (ev.ctrlKey || ev.metaKey) {
      // The two clicks before this toggled the face on and off again.
      if (!this.hasBody(hit.body)) this.set([...this.items, body]);
    } else {
      this.set([body]);
    }
  }

  // Middle-click: the whole body under the mouse. Ctrl adds or removes it.
  onMiddleClick(ev) {
    const hit = this.vp.pick(ev, { faces: true });
    const add = ev.ctrlKey || ev.metaKey;
    if (hit) this.pickItem({ kind: 'body', body: hit.body }, add);
    else if (!add) this.clear();
  }

  boxKind() { return 'bodies'; }

  onBoxSelect(items, ev) {
    if (!(ev.ctrlKey || ev.metaKey)) { this.set(items); return; }
    this.set([...this.items, ...items.filter((it) => !this.has(it))]);
  }

  // A body clicked in the browser tree.
  clickBody(id, add) { this.pickItem({ kind: 'body', body: id }, add); }
}
