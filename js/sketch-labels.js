// Labels drawn over the 3D view during sketching: dimension values and constraint icons.
// Each item sits at a world point, pushed out a few pixels in a world direction, and
// follows the camera.

import * as THREE from 'three';

export class SketchLabels {
  constructor(vp, { onClick, onDblClick }) {
    this.vp = vp;
    this.root = document.createElement('div');
    this.root.className = 'sk-labels';
    vp.el.appendChild(this.root);
    this.items = [];
    this.nodes = new Map();
    this.onClick = onClick;
    this.onDblClick = onDblClick;
    this.hook = () => this.place();
    vp.renderHooks.add(this.hook);
  }

  dispose() {
    this.vp.renderHooks.delete(this.hook);
    this.root.remove();
  }

  // items: [{ key, id, text, cls, title, world, dir, px, stack }]
  set(items) {
    this.items = items;
    const keep = new Set(items.map((it) => it.key));
    for (const [key, node] of this.nodes) if (!keep.has(key)) { node.remove(); this.nodes.delete(key); }
    for (const it of items) {
      let node = this.nodes.get(it.key);
      if (!node) {
        node = document.createElement('div');
        node.addEventListener('pointerdown', (e) => e.stopPropagation());
        node.addEventListener('click', (e) => { e.stopPropagation(); this.onClick(node.dataset.id, e); });
        node.addEventListener('dblclick', (e) => { e.stopPropagation(); this.onDblClick(node.dataset.id, node); });
        this.root.appendChild(node);
        this.nodes.set(it.key, node);
      }
      node.dataset.id = it.id;
      node.className = `sk-label ${it.cls}`;
      node.textContent = it.text;
      node.title = it.title || '';
    }
    this.vp.redraw();
  }

  place() {
    const cam = this.vp.camera;
    cam.updateMatrixWorld();
    const w = this.vp.el.clientWidth, h = this.vp.el.clientHeight;
    const toScreen = (p) => { const v = new THREE.Vector3(...p).project(cam); return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h]; };
    const upp = this.vp.unitsPerPixel();
    for (const it of this.items) {
      const node = this.nodes.get(it.key);
      if (!node) continue;
      const a = toScreen(it.world);
      const b = toScreen(it.world.map((v, i) => v + it.dir[i] * upp * 10));
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      dx /= l; dy /= l;
      // Several labels on one item stack sideways.
      const s = (it.stack || 0) * 18;
      node.style.left = `${a[0] + dx * it.px - dy * s}px`;
      node.style.top = `${a[1] + dy * it.px + dx * s}px`;
    }
  }
}
