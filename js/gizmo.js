// Move gizmo: three arrows to drag along X/Y/Z and three rings to rotate around them.
// Drawn on top of everything at a constant size on screen.

import * as THREE from 'three';

const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const COLORS = { x: 0xd23b3b, y: 0x2e9e45, z: 0x2f6fd6 };
const SIZE_PX = 110;

// `axes` maps handle names to directions; Press Pull uses a single arrow along a face normal.
export class Gizmo {
  constructor(vp, { axes = AXES, rings = true, size = SIZE_PX } = {}) {
    this.vp = vp;
    this.axes = axes;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.handles = [];  // invisible, fatter shapes used for picking
    this.visuals = {};  // handle key -> visible meshes
    const pickMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    const up = new THREE.Vector3(0, 1, 0);

    for (const [axis, dir] of Object.entries(axes)) {
      const mat = new THREE.MeshBasicMaterial({ color: COLORS[axis] ?? 0x0a6cff, depthTest: false, transparent: true, opacity: 0.85 });
      const q = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(...dir));

      // Arrow: shaft + cone, pointing along +axis.
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.8, 8), mat);
      shaft.position.set(0, 0.4, 0);
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.22, 16), mat);
      head.position.set(0, 0.91, 0);
      const arrow = new THREE.Group();
      arrow.add(shaft, head);
      arrow.quaternion.copy(q);
      const arrowPick = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.05, 8), pickMat);
      arrowPick.position.set(0, 0.52, 0);
      const arrowPickGroup = new THREE.Group();
      arrowPickGroup.add(arrowPick);
      arrowPickGroup.quaternion.copy(q);
      arrowPick.userData = { kind: 'move', axis };

      // Ring: a torus lying in the plane perpendicular to the axis.
      const ringQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...dir));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.012, 8, 64), mat.clone());
      ring.material.opacity = 0.7;
      ring.quaternion.copy(ringQ);
      const ringPick = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.06, 6, 48), pickMat);
      ringPick.quaternion.copy(ringQ);
      ringPick.userData = { kind: 'rotate', axis };

      this.group.add(arrow, arrowPickGroup);
      this.handles.push(arrowPick);
      this.visuals[`move:${axis}`] = [shaft, head];
      if (rings) {
        this.group.add(ring, ringPick);
        this.handles.push(ringPick);
        this.visuals[`rotate:${axis}`] = [ring];
      }
    }
    this.group.traverse((o) => { o.renderOrder = 20; });
    vp.scene.add(this.group);
    this.hook = () => this.group.scale.setScalar(vp.unitsPerPixel() * size);
    vp.renderHooks.add(this.hook);
  }

  dispose() {
    this.vp.scene.remove(this.group);
    this.vp.renderHooks.delete(this.hook);
    this.vp.redraw();
  }

  setCenter(c) {
    this.group.visible = !!c;
    if (c) this.group.position.set(...c);
    this.vp.redraw();
  }

  hit(ev) {
    if (!this.group.visible) return null;
    this.group.updateMatrixWorld(true);
    const h = this.vp.ray(ev).intersectObjects(this.handles, false)[0];
    return h ? h.object.userData : null;
  }

  setHover(handle) {
    const key = handle ? `${handle.kind}:${handle.axis}` : null;
    for (const [k, meshes] of Object.entries(this.visuals)) {
      for (const m of meshes) m.material.opacity = k === key ? 1 : k.startsWith('rotate') ? 0.7 : 0.85;
    }
    this.vp.redraw();
  }

  // Start dragging a handle; returns false if the drag can't start from this view.
  begin(ev, handle) {
    const c = this.group.position.clone();
    const dir = new THREE.Vector3(...this.axes[handle.axis]);
    this.drag = { handle, c, dir };
    if (handle.kind === 'move') {
      this.drag.t0 = this.axisParam(ev);
      return this.drag.t0 != null;
    }
    this.drag.v0 = this.ringVector(ev);
    return this.drag.v0 != null;
  }

  // Current drag amount: millimetres along the axis, or degrees around it.
  amount(ev) {
    const d = this.drag;
    if (!d) return null;
    if (d.handle.kind === 'move') {
      const t = this.axisParam(ev);
      return t == null ? null : t - d.t0;
    }
    const v = this.ringVector(ev);
    if (!v) return null;
    const sin = new THREE.Vector3().crossVectors(d.v0, v).dot(d.dir);
    return THREE.MathUtils.radToDeg(Math.atan2(sin, d.v0.dot(v)));
  }

  end() { this.drag = null; }

  // Position along the drag axis closest to the mouse ray.
  axisParam(ev) {
    const { c, dir } = this.drag;
    const ray = this.vp.ray(ev).ray;
    const w0 = new THREE.Vector3().subVectors(c, ray.origin);
    const b = dir.dot(ray.direction);
    const denom = 1 - b * b;
    if (denom < 1e-4) return null; // looking straight down the axis
    return (b * ray.direction.dot(w0) - dir.dot(w0)) / denom;
  }

  // Direction from the centre to where the mouse ray meets the ring's plane.
  ringVector(ev) {
    const { c, dir } = this.drag;
    const ray = this.vp.ray(ev).ray;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir, c);
    if (Math.abs(ray.direction.dot(dir)) < 1e-3) return null; // ring seen edge-on
    const p = ray.intersectPlane(plane, new THREE.Vector3());
    if (!p) return null;
    const v = p.sub(c);
    return v.lengthSq() > 1e-12 ? v.normalize() : null;
  }
}
