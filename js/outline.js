// Instant outlines drawn while dragging, straight from the numbers, so the shape
// follows the mouse even when the kernel takes a moment. The real preview catches up.
// Each returns { geometry, matrix } (shown as its edges) or { lines: [[x,y,z], ...] }, or null.

import * as THREE from 'three';
import { buildProfiles, sketchFrame } from './profiles.js';
import { primFrame } from './shape-drag.js';

const V = (a) => new THREE.Vector3(...a);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const along = (c, n, d) => c.map((v, i) => v + n[i] * d);

// A matrix whose local X, Y and Z axes are the given world directions, placed at `pos`.
const basis = (x, y, z, pos) => new THREE.Matrix4().makeBasis(V(x), V(y), V(z)).setPosition(...pos);

export function primitiveOutline(type, p) {
  if (!p.point || !p.normal || !p.xDir) return null;
  const { c, x, n } = primFrame(p);
  const y = cross(n, x);
  const h = Number(p.height) || 0;
  const pos = (...v) => v.every((k) => Number(k) > 0);
  switch (type) {
    case 'box':
      if (!pos(p.width, p.depth, h)) return null;
      return { geometry: new THREE.BoxGeometry(p.width, p.depth, h), matrix: basis(x, y, n, along(c, n, h / 2)) };
    case 'cylinder':
      if (!pos(p.diameter, h)) return null;
      // three.js cylinders stand along their local Y axis.
      return { geometry: new THREE.CylinderGeometry(p.diameter / 2, p.diameter / 2, h, 48, 1), matrix: basis(x, n, cross(x, n), along(c, n, h / 2)) };
    case 'cone':
      if (!pos(p.bottomDiameter, h)) return null;
      return {
        geometry: new THREE.CylinderGeometry(Math.max(0, Number(p.topDiameter) || 0) / 2, p.bottomDiameter / 2, h, 48, 1),
        matrix: basis(x, n, cross(x, n), along(c, n, h / 2)),
      };
    case 'sphere':
      if (!pos(p.diameter)) return null;
      return { geometry: new THREE.SphereGeometry(p.diameter / 2, 24, 12), matrix: basis(x, y, n, c) };
    case 'torus':
      if (!pos(p.ringDiameter, p.tubeDiameter)) return null;
      return { geometry: new THREE.TorusGeometry(p.ringDiameter / 2, p.tubeDiameter / 2, 12, 48), matrix: basis(x, y, n, c) };
  }
  return null;
}

// Press Pull: the face's outline where it starts and where it ends, joined at the corners.
export function pressPullOutline(vp, p) {
  if (!p.face || !p.normal) return null;
  const f = vp.findFace(p.face);
  const b = f && vp.bodyData.find((x) => x.id === f.body);
  if (!b) return null;
  const g = b.faceGroups[f.group];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(b.vertices, 3));
  geo.setIndex(Array.from(b.triangles.subarray(g.start, g.start + g.count)));
  // Edges used by only one triangle form the face's boundary.
  const edge = new THREE.EdgesGeometry(geo, 1).attributes.position.array;
  const d = Number(p.distance) || 0;
  const lines = [];
  for (let i = 0; i < edge.length; i += 6) {
    const a = [edge[i], edge[i + 1], edge[i + 2]], e = [edge[i + 3], edge[i + 4], edge[i + 5]];
    lines.push(a, e, along(a, p.normal, d), along(e, p.normal, d), a, along(a, p.normal, d));
  }
  return { lines };
}

// Extrude: the chosen profiles pushed out by the distance, placed as the kernel does it.
export function extrudeOutline(app, p) {
  const sk = app.featureById(p.sketch);
  const d = Number(p.distance) || 0;
  if (!sk || !d) return null;
  const { loops, regions } = buildProfiles(sk.params.entities);
  const picked = p.profiles === 'all' ? regions : p.profiles.map((i) => regions[i]).filter(Boolean);
  if (!picked.length) return null;
  const shapes = picked.map((r) => {
    const s = new THREE.Shape(loops[r.outer].poly.map(([u, v]) => new THREE.Vector2(u, v)));
    for (const h of r.holes) s.holes.push(new THREE.Path(loops[h].poly.map(([u, v]) => new THREE.Vector2(u, v))));
    return s;
  });
  const depth = Math.abs(d);
  const shift = p.direction === 'symmetric' ? -depth / 2 : d < 0 ? d : 0;
  const fr = sketchFrame(sk.params);
  return {
    geometry: new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false }),
    matrix: basis(fr.xDir, fr.yDir, fr.normal, along(fr.origin, fr.normal, shift)),
  };
}
