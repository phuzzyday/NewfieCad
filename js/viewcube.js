// View cube: mirrors the main camera's orientation; click a face, edge or corner to look from there.

import * as THREE from 'three';

// Faces are plain colours (a shade per direction, so the cube reads as solid), and the words are
// page text over each face facing the camera. Painting words into textures goes through a 2D
// canvas, which privacy browsers (Brave Shields) block, leaving the faces black.
const FACES = [
  { n: [0, 0, 1], label: 'TOP', color: 0xf6f8fa },
  { n: [0, 0, -1], label: 'BOTTOM', color: 0xf6f8fa },
  { n: [0, -1, 0], label: 'FRONT', color: 0xe9edf1 },
  { n: [0, 1, 0], label: 'BACK', color: 0xe9edf1 },
  { n: [1, 0, 0], label: 'RIGHT', color: 0xdde3e9 },
  { n: [-1, 0, 0], label: 'LEFT', color: 0xdde3e9 },
];
const SIZE = 110;

export class ViewCube {
  constructor(el, viewport) {
    this.vp = viewport;
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(SIZE, SIZE);
    el.appendChild(this.renderer.domElement);
    this.labels = FACES.map((f) => {
      const span = document.createElement('span');
      span.className = 'vc-label';
      span.textContent = f.label;
      el.appendChild(span);
      return { span, n: new THREE.Vector3(...f.n) };
    });
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-0.95, 0.95, 0.95, -0.95, 0.1, 10);
    this.cube = new THREE.Group();
    for (const f of FACES) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: f.color }));
      mesh.lookAt(...f.n);
      mesh.position.set(...f.n.map((v) => v / 2));
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
    // Each word sits on its face's centre while that face turns towards the camera, fading in.
    const toCam = this.camera.position.clone().normalize();
    for (const { span, n } of this.labels) {
      const facing = n.dot(toCam);
      const show = facing > 0.2;
      span.style.opacity = show ? Math.min(1, (facing - 0.2) / 0.35) : 0;
      if (!show) continue;
      const p = n.clone().multiplyScalar(0.5).project(this.camera);
      span.style.left = `${((p.x + 1) / 2) * SIZE}px`;
      span.style.top = `${((1 - p.y) / 2) * SIZE}px`;
    }
  }
}
