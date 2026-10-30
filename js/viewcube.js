// View cube: mirrors the main camera's orientation; click a face, edge or corner to look from there.

import * as THREE from 'three';

const FACES = [
  { n: [0, 0, 1], up: [0, 1, 0], label: 'TOP' },
  { n: [0, 0, -1], up: [0, 1, 0], label: 'BOTTOM' },
  { n: [0, -1, 0], up: [0, 0, 1], label: 'FRONT' },
  { n: [0, 1, 0], up: [0, 0, 1], label: 'BACK' },
  { n: [1, 0, 0], up: [0, 0, 1], label: 'RIGHT' },
  { n: [-1, 0, 0], up: [0, 0, 1], label: 'LEFT' },
];

function labelTexture(text) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#f4f6f8';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#9aa5b1';
  g.lineWidth = 4;
  g.strokeRect(2, 2, 124, 124);
  g.fillStyle = '#3a4550';
  g.font = `bold ${text.length > 5 ? 22 : 26}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 64, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ViewCube {
  constructor(el, viewport) {
    this.vp = viewport;
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(110, 110);
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-0.95, 0.95, 0.95, -0.95, 0.1, 10);
    this.cube = new THREE.Group();
    for (const f of FACES) {
      const n = new THREE.Vector3(...f.n), up = new THREE.Vector3(...f.up);
      const right = up.clone().cross(n);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: labelTexture(f.label) }));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.makeBasis(right, up, n).setPosition(n.multiplyScalar(0.5));
      this.cube.add(mesh);
    }
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x7d8894 }));
    this.cube.add(box);
    this.hitBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ visible: false }));
    this.cube.add(this.hitBox);
    this.scene.add(this.cube);

    const axis = (dir, color) => new THREE.ArrowHelper(new THREE.Vector3(...dir), new THREE.Vector3(-0.5, -0.5, -0.5), 0.75, color, 0.1, 0.06);
    this.scene.add(axis([1, 0, 0], 0xd23b3b), axis([0, 1, 0], 0x2e9e45), axis([0, 0, 1], 0x2f6fd6));

    this.renderer.domElement.addEventListener('click', (ev) => this.onClick(ev));
    viewport.onRender = () => this.render();
  }

  onClick(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, this.camera);
    const hit = rc.intersectObject(this.hitBox)[0];
    if (!hit) return;
    // Snap the hit point to a face, edge or corner direction.
    const p = hit.point;
    const s = (v) => (Math.abs(v) > 0.3 ? Math.sign(v) : 0);
    const side = new THREE.Vector3(s(p.x), s(p.y), s(p.z));
    if (side.lengthSq() === 0) return;
    const dir = side.normalize().negate();
    const vertical = Math.abs(dir.z) > 0.999;
    this.vp.setView(dir, vertical ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1));
  }

  render() {
    const q = this.vp.quat;
    this.camera.position.set(0, 0, 3).applyQuaternion(q);
    this.camera.quaternion.copy(q);
    this.renderer.render(this.scene, this.camera);
  }
}
