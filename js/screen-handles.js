// Small on-screen handles pinned to points in the model: count tags ("◀ 3 ▶") that are
// dragged sideways or clicked, and dots that are dragged around. Used by the pattern
// dialogs. They follow the camera, and are kept (not rebuilt) while dragged.

const COUNT_STEP_PX = 24; // sideways drag per copy

export class ScreenHandles {
  constructor(vp) {
    this.vp = vp;
    this.layer = document.createElement('div');
    this.layer.className = 'screen-handles';
    vp.el.appendChild(this.layer);
    this.items = new Map(); // key -> { spec, el }
    this.hook = () => this.place();
    vp.renderHooks.add(this.hook);
  }

  dispose() {
    this.vp.renderHooks.delete(this.hook);
    this.layer.remove();
  }

  // specs: [{ key, kind: 'count' | 'dot', pos, value?, title, onCount?(v, live), onStart?, onMove?, onEnd? }]
  set(specs) {
    const keep = new Set(specs.map((s) => s.key));
    for (const [key, it] of this.items) {
      if (!keep.has(key) && !it.dragging) { it.el.remove(); this.items.delete(key); }
    }
    for (const spec of specs) {
      let it = this.items.get(spec.key);
      if (!it) { it = { el: this.make(spec) }; this.items.set(spec.key, it); this.layer.appendChild(it.el); }
      it.spec = spec;
      if (spec.kind === 'count') it.el.querySelector('.count-value').textContent = `× ${spec.value}`;
      it.el.title = spec.title || '';
    }
    this.place();
  }

  make(spec) {
    const key = spec.key;
    const spec_ = () => this.items.get(key).spec;
    const el = document.createElement('div');
    el.className = `screen-handle ${spec.kind}`;
    if (spec.kind === 'count') {
      const less = document.createElement('button');
      const value = document.createElement('span');
      const more = document.createElement('button');
      less.textContent = '◀';
      more.textContent = '▶';
      value.className = 'count-value';
      less.title = 'One fewer';
      more.title = 'One more';
      less.onclick = () => spec_().onCount(spec_().value - 1, false);
      more.onclick = () => spec_().onCount(spec_().value + 1, false);
      el.append(less, value, more);
      value.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        value.setPointerCapture(ev.pointerId);
        const it = this.items.get(key), x0 = ev.clientX, v0 = it.spec.value;
        it.dragging = true;
        let last = v0;
        const move = (e) => {
          const v = v0 + Math.round((e.clientX - x0) / COUNT_STEP_PX);
          if (v !== last) { last = v; it.spec.onCount(v, true); }
        };
        const up = () => {
          it.dragging = false;
          value.removeEventListener('pointermove', move);
          value.removeEventListener('pointerup', up);
          value.removeEventListener('pointercancel', up);
          it.spec.onCount(last, false);
        };
        value.addEventListener('pointermove', move);
        value.addEventListener('pointerup', up);
        value.addEventListener('pointercancel', up);
      });
    } else {
      el.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        el.setPointerCapture(ev.pointerId);
        const it = this.items.get(key);
        it.dragging = true;
        it.spec.onStart?.(ev);
        const move = (e) => it.spec.onMove?.(e);
        const up = () => {
          it.dragging = false;
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
          it.spec.onEnd?.();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      });
    }
    return el;
  }

  place() {
    const r = this.vp.el.getBoundingClientRect();
    for (const { spec, el } of this.items.values()) {
      const [x, y] = this.vp.toScreen(spec.pos);
      el.style.left = `${x - r.left}px`;
      el.style.top = `${y - r.top}px`;
    }
  }
}
