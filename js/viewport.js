// 3D viewport: Fusion-style camera (Z up), body/sketch display, picking and highlights.

import * as THREE from 'three';
import { buildProfiles, entityPolyline, entityPoints, toWorld, PLANES } from './profiles.js';

const COLORS = {
  body: 0xc4ccd4,
  edge: 0x20262c,
  hover: 0x6fb6ff,
  select: 0x0a6cff,
  sketch: 0x1f4fa8,
  sketchActive: 0x0a6cff,
  region: 0x5aa0ff,
  regionSel: 0x0a6cff,
  ghost: 0x4a90e2,
};

const FOV = 40;

// Visual styles, as in Fusion (plus see-through). Only the model's bodies use them.
export const VISUAL_STYLES = [
  ['shaded', 'Shaded'],
  ['shadedEdges', 'Shaded with visible edges'],
  ['shadedHidden', 'Shaded with hidden edges'],
  ['wireframe', 'Wireframe'],
  ['wireframeVisible', 'Wireframe, visible edges only'],
  ['xray', 'See-through'],
];
const vec = (v) => (Array.isArray(v) ? new THREE.Vector3(...v) : v);

// Does the 2D segment a-b cross the rectangle r? (Liang-Barsky clipping)
function segHitsRect(a, b, r) {
  if (!a || !b) return false;
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - r.x0], [dx, r.x1 - a[0]], [-dy, a[1] - r.y0], [dy, r.y1 - a[1]]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

export class Viewport {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    el.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xeef1f4);
    this.persp = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200000);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -200000, 200000);
    this.useOrtho = false;

    // Camera state: position, orientation and a focus point straight ahead.
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.target = new THREE.Vector3();
    this.setViewImmediate(new THREE.Vector3(-1, 1, -0.8).normalize(), new THREE.Vector3(0, 0, 1), 260);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xa0aab5, 2.2));
    this.headlight = new THREE.DirectionalLight(0xffffff, 1.1);
    this.scene.add(this.headlight, this.headlight.target);

    this.addGrid();
    this.bodies = new THREE.Group();
    this.preview = new THREE.Group();
    this.sketches = new THREE.Group();
    this.overlay = new THREE.Group();
    this.planes = new THREE.Group();
    this.outline = new THREE.Group();
    this.scene.add(this.bodies, this.preview, this.sketches, this.overlay, this.planes, this.outline);

    this.bodyData = []; // [{ id, name, mesh, lines, faceGroups, edgeGroups }]
    this.regionMeshes = [];
    this.style = 'shadedEdges';
    this.tool = null;
    this.idleTool = null; // gets the mouse when no command is running (selection)
    this.renderHooks = new Set();
    this.raycaster = new THREE.Raycaster();
    this.dirty = true;
    this.anim = null;

    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    const loop = (t) => {
      if (this.anim) this.stepAnim(t);
      if (this.dirty) { this.render(); this.dirty = false; }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---------- scene helpers ----------

  addGrid() {
    const g = new THREE.Group();
    const minor = new THREE.GridHelper(400, 80, 0xd3d9df, 0xd3d9df);
    const major = new THREE.GridHelper(400, 8, 0xb4bcc4, 0xb4bcc4);
    for (const grid of [minor, major]) {
      grid.rotation.x = Math.PI / 2;
      grid.material.depthWrite = false;
      g.add(grid);
    }
    const axis = (to, color) => {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), to]);
      return new THREE.Line(geo, new THREE.LineBasicMaterial({ color }));
    };
    g.add(axis(new THREE.Vector3(200, 0, 0), 0xd23b3b), axis(new THREE.Vector3(0, 200, 0), 0x2e9e45), axis(new THREE.Vector3(0, 0, 200), 0x2f6fd6));
    g.renderOrder = -1;
    this.grid = g;
    this.scene.add(g);
  }

  showOriginPlanes(show, highlight = null) {
    this.planes.clear();
    if (!show) { this.redraw(); return; }
    const colors = { XY: 0x2f6fd6, XZ: 0x2e9e45, YZ: 0xd23b3b };
    for (const name of Object.keys(PLANES)) {
      const p = PLANES[name];
      const s = 60;
      const pts = [[-s, -s], [s, -s], [s, s], [-s, s]].map(([u, v]) => new THREE.Vector3(...toWorld({ ...p, origin: [0, 0, 0] }, u, v)));
      const geo = new THREE.BufferGeometry().setFromPoints([pts[0], pts[1], pts[2], pts[0], pts[2], pts[3]]);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: colors[name], transparent: true, opacity: highlight === name ? 0.4 : 0.15, side: THREE.DoubleSide, depthWrite: false,
      }));
      mesh.userData.plane = name;
      const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: colors[name] }));
      this.planes.add(mesh, outline);
    }
    this.redraw();
  }

  makeBodyObjects(b, { ghost = false, pickOnly = false, showEdges = true } = {}) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(b.vertices, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(b.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(b.triangles, 1));
    let mat;
    if (pickOnly) mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    else if (ghost) mat = new THREE.MeshStandardMaterial({ color: COLORS.ghost, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
    else mat = new THREE.MeshStandardMaterial({ color: COLORS.body, metalness: 0.05, roughness: 0.65, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    const objs = [mesh];
    let lines = null;
    if (b.lines && showEdges) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(b.lines, 3));
      lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: ghost ? 0x2a5f9e : COLORS.edge }));
      objs.push(lines);
    }
    return { mesh, lines, objs };
  }

  // Bodies the user sees and picks. `opts.visible` false keeps them pickable but hidden.
  setBodies(bodies, opts = {}) {
    const { visible = true, showEdges = true, hidden = new Set() } = opts;
    this.lastBodies = [bodies, opts];
    this.bodies.clear();
    this.bodyData = [];
    for (const b of bodies) {
      const isHidden = hidden.has(b.id);
      const o = this.makeBodyObjects(b, { pickOnly: !visible || isHidden, showEdges: showEdges && !isHidden });
      if (visible && !isHidden) this.applyStyle(o);
      o.objs.forEach((x) => this.bodies.add(x));
      this.bodyData.push({ ...b, mesh: isHidden ? null : o.mesh, lineObj: isHidden ? null : o.lines });
    }
    this.redraw();
  }

  setStyle(style) {
    this.style = style;
    if (this.lastBodies) this.setBodies(...this.lastBodies);
  }

  // Change one body's surface and edges to suit the visual style. Surfaces always stay
  // pickable, even when they aren't drawn.
  applyStyle(o) {
    const m = o.mesh.material, s = this.style;
    if (s === 'wireframe' || s === 'wireframeVisible') {
      m.colorWrite = false;
      // Visible-only: the invisible surfaces still hide the edges behind them.
      m.depthWrite = s === 'wireframeVisible';
    } else if (s === 'xray') {
      Object.assign(m, { transparent: true, opacity: 0.3, depthWrite: false });
    }
    if (!o.lines) return;
    if (s === 'shaded') { o.lines.visible = false; return; }
    if (s === 'shadedHidden') {
      // Edges behind surfaces: a second, faint dashed copy drawn only where something is in front.
      const dash = this.unitsPerPixel() * 4;
      const hiddenLines = new THREE.LineSegments(o.lines.geometry, new THREE.LineDashedMaterial({
        color: COLORS.edge, dashSize: dash, gapSize: dash * 0.8, transparent: true, opacity: 0.45,
        depthFunc: THREE.GreaterDepth, depthWrite: false,
      }));
      hiddenLines.computeLineDistances();
      hiddenLines.renderOrder = 2;
      o.objs.push(hiddenLines);
    }
  }

  setPreview(bodies, ghost = false) {
    this.preview.clear();
    for (const b of bodies || []) {
      const o = this.makeBodyObjects(b, { ghost });
      if (!ghost) this.applyStyle(o); // previews follow the chosen visual style too
      o.objs.forEach((x) => this.preview.add(x));
    }
    this.redraw();
  }

  // sketches: [{ frame, entities, active, selected:Set(index), regions, selectedRegions, showRegions,
  //              colors?, dashed?, noDots?, regionEntities? }] — colors/dashed are per entity.
  setSketches(list) {
    this.sketches.clear();
    this.regionMeshes = [];
    for (const sk of list) {
      const frame = sk.frame;
      const w = (u, v) => new THREE.Vector3(...toWorld(frame, u, v));
      sk.entities.forEach((e, i) => {
        const pts = entityPolyline(e).map(([u, v]) => w(u, v));
        const color = sk.colors?.[i] ?? (sk.selected?.has(i) ? COLORS.select : sk.active ? COLORS.sketchActive : COLORS.sketch);
        const dash = this.unitsPerPixel() * 6;
        const mat = sk.dashed?.[i]
          ? new THREE.LineDashedMaterial({ color, dashSize: dash, gapSize: dash * 0.7, depthTest: !sk.active })
          : new THREE.LineBasicMaterial({ color, depthTest: !sk.active });
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
        if (sk.dashed?.[i]) line.computeLineDistances();
        line.renderOrder = 5;
        line.userData = { entity: i, sketch: sk.id };
        this.sketches.add(line);
      });
      if (sk.active && !sk.noDots) {
        const dots = sk.entities.flatMap(entityPoints).map(([u, v]) => w(u, v));
        if (dots.length) {
          const pm = new THREE.Points(new THREE.BufferGeometry().setFromPoints(dots), new THREE.PointsMaterial({ color: 0x0a3f99, size: 5, sizeAttenuation: false, depthTest: false }));
          pm.renderOrder = 6;
          this.sketches.add(pm);
        }
      }
      if (sk.showRegions) this.addRegions(sk);
    }
    this.redraw();
  }

  addRegions(sk) {
    const { loops, regions } = buildProfiles(sk.regionEntities || sk.entities);
    const m = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...sk.frame.xDir), new THREE.Vector3(...sk.frame.yDir), new THREE.Vector3(...sk.frame.normal));
    m.setPosition(...sk.frame.origin);
    regions.forEach((r, idx) => {
      const shape = new THREE.Shape(loops[r.outer].poly.map(([x, y]) => new THREE.Vector2(x, y)));
      for (const h of r.holes) shape.holes.push(new THREE.Path(loops[h].poly.map(([x, y]) => new THREE.Vector2(x, y))));
      const sel = sk.selectedRegions === 'all' || sk.selectedRegions?.includes(idx);
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({
        color: sel ? COLORS.regionSel : COLORS.region, transparent: true, opacity: sel ? 0.45 : 0.15,
        side: THREE.DoubleSide, depthWrite: false,
      }));
      mesh.applyMatrix4(m);
      // Pickable at once, not only after the next frame is drawn.
      mesh.updateMatrixWorld();
      mesh.renderOrder = 4;
      mesh.userData.region = idx;
      mesh.userData.sketch = sk.id;
      this.sketches.add(mesh);
      this.regionMeshes.push(mesh);
    });
  }

  // Overlays: [{ kind:'edge', points:[[x,y,z]...], color } | { kind:'face', body, group, color } | { kind:'points', points, color }]
  setOverlay(items) {
    this.overlay.clear();
    for (const it of items) {
      if (it.kind === 'edge' || it.kind === 'polyline') {
        const pts = it.points.map((p) => new THREE.Vector3(...p));
        const obj = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: it.color, depthTest: false, linewidth: 2 }));
        obj.renderOrder = 10;
        this.overlay.add(obj);
        // A second, slightly offset copy makes thin lines easier to see.
        const thick = obj.clone();
        thick.position.copy(this.screenOffset());
        this.overlay.add(thick);
      } else if (it.kind === 'face') {
        const b = this.bodyData.find((x) => x.id === it.body);
        if (!b) continue;
        const g = b.faceGroups[it.group];
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(b.vertices, 3));
        geo.setIndex(Array.from(b.triangles.subarray(g.start, g.start + g.count)));
        const obj = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: it.color, transparent: true, opacity: 0.55, depthTest: false, side: THREE.DoubleSide }));
        obj.renderOrder = 9;
        this.overlay.add(obj);
      } else if (it.kind === 'body') {
        const b = this.bodyData.find((x) => x.id === it.body);
        if (!b) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(b.vertices, 3));
        geo.setIndex(new THREE.BufferAttribute(b.triangles, 1));
        const obj = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: it.color, transparent: true, opacity: 0.3, depthTest: false, side: THREE.DoubleSide }));
        obj.renderOrder = 9;
        this.overlay.add(obj);
      } else if (it.kind === 'quad') {
        // A see-through square (Split Body's cut plane) with its border.
        const [a, b, c, d] = it.corners.map((p) => new THREE.Vector3(...p));
        const fill = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([a, b, c, a, c, d]), new THREE.MeshBasicMaterial({
          color: it.color, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide,
        }));
        const border = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([a, b, c, d]), new THREE.LineBasicMaterial({ color: it.color }));
        fill.renderOrder = 8;
        border.renderOrder = 8;
        this.overlay.add(fill, border);
      } else if (it.kind === 'points') {
        const obj = new THREE.Points(new THREE.BufferGeometry().setFromPoints(it.points.map((p) => new THREE.Vector3(...p))),
          new THREE.PointsMaterial({ color: it.color, size: it.size || 8, sizeAttenuation: false, depthTest: false }));
        obj.renderOrder = 11;
        this.overlay.add(obj);
      }
    }
    this.redraw();
  }

  // Instant drag outline: { geometry, matrix } drawn as its edges, { lines } as segments,
  // { positions, matrix } as ready-made segments, or null.
  setOutline(o) {
    for (const c of this.outline.children) c.geometry.dispose();
    this.outline.clear();
    if (o) {
      let geo;
      if (o.positions) geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(o.positions, 3));
      else if (o.lines) geo = new THREE.BufferGeometry().setFromPoints(o.lines.map((p) => new THREE.Vector3(...p)));
      else geo = new THREE.EdgesGeometry(o.geometry, 25);
      o.geometry?.dispose();
      const obj = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: COLORS.select, depthTest: false, transparent: true, opacity: 0.9 }));
      if (o.matrix) obj.applyMatrix4(o.matrix);
      obj.renderOrder = 12;
      this.outline.add(obj);
    }
    this.redraw();
  }

  screenOffset() {
    const upp = this.unitsPerPixel();
    return new THREE.Vector3(0.6 * upp, 0, 0).applyQuaternion(this.quat);
  }

  // ---------- body geometry queries ----------

  edgePoints(b, gi) {
    const g = b.edgeGroups[gi];
    const out = [];
    for (let i = g.start; i < g.start + g.count; i++) out.push([b.lines[i * 3], b.lines[i * 3 + 1], b.lines[i * 3 + 2]]);
    return out;
  }

  edgeSig(points) {
    // Line segment pairs -> half-length point.
    let total = 0;
    const segs = [];
    for (let i = 0; i + 1 < points.length; i += 2) {
      const l = Math.hypot(...points[i + 1].map((v, k) => v - points[i][k]));
      segs.push([points[i], points[i + 1], l]);
      total += l;
    }
    let acc = 0, mid = points[0];
    for (const [a, b, l] of segs) {
      if (acc + l >= total / 2) {
        const t = l ? (total / 2 - acc) / l : 0;
        mid = a.map((v, k) => v + (b[k] - v) * t);
        break;
      }
      acc += l;
    }
    return { s: points[0], e: points[points.length - 1], m: mid };
  }

  faceInfo(b, gi) {
    const g = b.faceGroups[gi];
    const v = b.vertices, t = b.triangles;
    let area = 0;
    const c = [0, 0, 0], n = [0, 0, 0];
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const p = [t[i], t[i + 1], t[i + 2]].map((k) => new THREE.Vector3(v[k * 3], v[k * 3 + 1], v[k * 3 + 2]));
      const cr = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]));
      const a = cr.length() / 2;
      area += a;
      for (let k = 0; k < 3; k++) {
        c[k] += ((p[0].getComponent(k) + p[1].getComponent(k) + p[2].getComponent(k)) / 3) * a;
        n[k] += cr.getComponent(k) / 2;
      }
    }
    const nl = Math.hypot(...n) || 1;
    return { c: c.map((x) => x / (area || 1)), n: n.map((x) => x / nl), area };
  }

  // A face is flat when all its mesh normals point the same way.
  faceIsFlat(b, gi) {
    const g = b.faceGroups[gi], t = b.triangles, nm = b.normals;
    const k0 = t[g.start] * 3;
    for (let i = g.start + 1; i < g.start + g.count; i++) {
      const k = t[i] * 3;
      if (nm[k] * nm[k0] + nm[k + 1] * nm[k0 + 1] + nm[k + 2] * nm[k0 + 2] < 0.9999) return false;
    }
    return true;
  }

  faceItem(b, gi) {
    const info = this.faceInfo(b, gi);
    return { kind: 'face', body: b.id, group: gi, point: info.c, normal: info.n, sig: { c: info.c, n: info.n }, flat: this.faceIsFlat(b, gi) };
  }

  // Bodies, faces or edges inside a screen rectangle (client pixels). A left-to-right
  // "window" box takes items fully inside it; a right-to-left "crossing" box takes
  // anything it touches.
  boxSelect(r, crossing, kind) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const c = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3();
    const proj = (arr, i) => {
      v.set(arr[i], arr[i + 1], arr[i + 2]).project(cam);
      return v.z > 1 ? null : [c.left + ((v.x + 1) / 2) * c.width, c.top + ((1 - v.y) / 2) * c.height];
    };
    const inside = (s) => s && s[0] >= r.x0 && s[0] <= r.x1 && s[1] >= r.y0 && s[1] <= r.y1;
    const test = (pts) => (crossing ? pts.some(inside) : pts.every(inside));
    // A crossing box drawn inside a big face has no corners in it; count what's under its middle.
    const mid = crossing ? this.pick({ clientX: (r.x0 + r.x1) / 2, clientY: (r.y0 + r.y1) / 2 }, { faces: true }) : null;
    const out = [];
    for (const b of this.bodyData) {
      if (!b.mesh) continue;
      if (kind === 'bodies') {
        const pts = [];
        for (let i = 0; i < b.vertices.length; i += 3) pts.push(proj(b.vertices, i));
        if (test(pts) || mid?.body === b.id) out.push({ kind: 'body', body: b.id });
      } else if (kind === 'faces') {
        b.faceGroups.forEach((g, gi) => {
          const pts = [];
          for (let i = g.start; i < g.start + g.count; i++) pts.push(proj(b.vertices, b.triangles[i] * 3));
          if (test(pts) || (mid?.body === b.id && mid.group === gi)) out.push(this.faceItem(b, gi));
        });
      } else if (kind === 'edges' && b.lineObj) {
        b.edgeGroups.forEach((g, gi) => {
          const pts = [];
          for (let i = g.start; i < g.start + g.count; i++) pts.push(proj(b.lines, i * 3));
          let hit = test(pts);
          for (let i = 0; crossing && !hit && i + 1 < pts.length; i += 2) hit = segHitsRect(pts[i], pts[i + 1], r);
          if (hit) {
            const points = this.edgePoints(b, gi);
            out.push({ kind: 'edge', body: b.id, group: gi, points, sig: this.edgeSig(points) });
          }
        });
      }
    }
    return out;
  }

  findEdge(sig) {
    let best = null, bestScore = Infinity;
    for (const b of this.bodyData) {
      b.edgeGroups?.forEach((_, gi) => {
        const pts = this.edgePoints(b, gi);
        const s = this.edgeSig(pts);
        const d = (x, y) => Math.hypot(...x.map((v, k) => v - y[k]));
        const sc = d(sig.m, s.m) + Math.min(d(sig.s, s.s) + d(sig.e, s.e), d(sig.s, s.e) + d(sig.e, s.s));
        if (sc < bestScore) { bestScore = sc; best = pts; }
      });
    }
    return bestScore < 1 ? best : null;
  }

  // Centre of the bounding box of the given bodies, or null.
  bodiesCenter(ids) {
    const box = new THREE.Box3();
    for (const b of this.bodyData) {
      if (!ids.includes(b.id)) continue;
      for (let i = 0; i < b.vertices.length; i += 3) box.expandByPoint(new THREE.Vector3(b.vertices[i], b.vertices[i + 1], b.vertices[i + 2]));
    }
    if (box.isEmpty()) return null;
    return box.getCenter(new THREE.Vector3()).toArray().map((v) => Math.round(v * 1000) / 1000);
  }

  findFace(sig) {
    let best = null, bestScore = Infinity;
    for (const b of this.bodyData) {
      b.faceGroups.forEach((_, gi) => {
        const f = this.faceInfo(b, gi);
        const sc = Math.hypot(...f.c.map((v, k) => v - sig.c[k])) + 10 * (1 - (f.n[0] * sig.n[0] + f.n[1] * sig.n[1] + f.n[2] * sig.n[2]));
        if (sc < bestScore) { bestScore = sc; best = { body: b.id, group: gi }; }
      });
    }
    return bestScore < 1 ? best : null;
  }

  // ---------- picking ----------

  ndc(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }

  ray(ev) {
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc(ev), this.camera);
    this.raycaster.params.Line.threshold = this.unitsPerPixel() * 5;
    this.raycaster.params.Points.threshold = this.unitsPerPixel() * 6;
    return this.raycaster;
  }

  // what: { edges, faces, planes, regions, entities }
  pick(ev, what) {
    const rc = this.ray(ev);
    if (what.regions && this.regionMeshes.length) {
      const hit = rc.intersectObjects(this.regionMeshes)[0];
      if (hit) return { kind: 'region', index: hit.object.userData.region, sketch: hit.object.userData.sketch };
    }
    if (what.planes) {
      // The origin planes overlap on screen. Where they do, take the one seen most squarely:
      // looking down, that is the floor, not a vertical plane that happens to be in front.
      // On a tie (the corner view) the floor wins.
      const squareness = (h) => Math.abs(rc.ray.direction.dot(new THREE.Vector3(...PLANES[h.object.userData.plane].normal)))
        + (h.object.userData.plane === 'XY' ? 0.05 : 0);
      const hit = rc.intersectObjects(this.planes.children.filter((o) => o.isMesh))
        .sort((a, b) => squareness(b) - squareness(a))[0];
      // Origin planes are see-through, so any body face under the cursor wins.
      const onFace = what.faces && rc.intersectObjects(this.bodyData.filter((b) => b.mesh).map((b) => b.mesh))[0];
      if (hit && !onFace) {
        return { kind: 'plane', name: hit.object.userData.plane, point: hit.point.toArray() };
      }
    }
    if (what.entities) {
      const hit = rc.intersectObjects(this.sketches.children.filter((o) => o.isLine))[0];
      if (hit) return { kind: 'entity', index: hit.object.userData.entity, sketch: hit.object.userData.sketch };
    }
    const meshes = this.bodyData.filter((b) => b.mesh).map((b) => b.mesh);
    const faceHit = rc.intersectObjects(meshes)[0];
    if (what.edges) {
      const lines = this.bodyData.filter((b) => b.lineObj).map((b) => b.lineObj);
      const hits = rc.intersectObjects(lines);
      // Only edges in front of (or on) the nearest face are pickable.
      const hit = hits.find((h) => !faceHit || h.distance <= faceHit.distance + this.unitsPerPixel() * 6);
      if (hit) {
        const b = this.bodyData.find((x) => x.lineObj === hit.object);
        const gi = b.edgeGroups.findIndex((g) => hit.index >= g.start && hit.index < g.start + g.count);
        if (gi >= 0) {
          const points = this.edgePoints(b, gi);
          return { kind: 'edge', body: b.id, group: gi, points, sig: this.edgeSig(points) };
        }
      }
    }
    if (what.faces && faceHit) {
      const b = this.bodyData.find((x) => x.mesh === faceHit.object);
      const idx = faceHit.faceIndex * 3;
      const gi = b.faceGroups.findIndex((g) => idx >= g.start && idx < g.start + g.count);
      if (gi >= 0) {
        const info = this.faceInfo(b, gi);
        const n = faceHit.face.normal.clone().transformDirection(faceHit.object.matrixWorld);
        return {
          kind: 'face', body: b.id, group: gi, point: faceHit.point.toArray(), normal: n.toArray(),
          sig: { c: info.c, n: info.n }, flat: this.faceIsFlat(b, gi),
        };
      }
    }
    return null;
  }

  // A world point's position on screen, in client pixels.
  toScreen(p) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.camera.updateMatrixWorld();
    const v = new THREE.Vector3(...p).project(this.camera);
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  }

  // A small marker where a point snapped (kind: corner, mid, center, edge, axis, origin), or none.
  setSnapMarker(point, kind) {
    if (!this.snapEl) {
      this.snapEl = document.createElement('div');
      this.el.appendChild(this.snapEl);
    }
    this.snapEl.hidden = !point;
    if (!point) return;
    const [x, y] = this.toScreen(point);
    const r = this.el.getBoundingClientRect();
    this.snapEl.className = `snap-marker ${kind}`;
    this.snapEl.style.left = `${x - r.left}px`;
    this.snapEl.style.top = `${y - r.top}px`;
  }

  // Intersection of the mouse ray with a sketch plane, in local (u, v).
  planeHit(ev, frame) {
    const rc = this.ray(ev);
    const n = new THREE.Vector3(...frame.normal);
    const o = new THREE.Vector3(...frame.origin);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, o);
    const p = rc.ray.intersectPlane(plane, new THREE.Vector3());
    if (!p) return null;
    p.sub(o);
    return [p.dot(new THREE.Vector3(...frame.xDir)), p.dot(new THREE.Vector3(...frame.yDir))];
  }

  // ---------- camera ----------

  get camera() { return this.useOrtho ? this.ortho : this.persp; }

  distance() { return this.pos.distanceTo(this.target); }

  unitsPerPixel() {
    const h = this.el.clientHeight || 1;
    return (2 * this.distance() * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / h;
  }

  forward() { return new THREE.Vector3(0, 0, -1).applyQuaternion(this.quat); }

  setViewImmediate(dir, up, dist) {
    dist = dist ?? this.distance();
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, up);
    this.quat.setFromRotationMatrix(m);
    this.pos.copy(this.target).addScaledVector(dir, -dist);
    this.redraw();
  }

  // Animate to look along `dir` (view direction) with `up`.
  setView(dir, up, dist = null, target = null) {
    dir = vec(dir); up = vec(up);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, up);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    const t = (target || this.target).clone();
    const d = dist ?? this.distance();
    this.anim = {
      start: null, q0: this.quat.clone(), q1: q,
      t0: this.target.clone(), t1: t, d0: this.distance(), d1: d,
    };
    this.redraw();
  }

  stepAnim(time) {
    const a = this.anim;
    if (a.start == null) a.start = time;
    const k = Math.min(1, (time - a.start) / 350);
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    this.quat.slerpQuaternions(a.q0, a.q1, e);
    this.target.lerpVectors(a.t0, a.t1, e);
    const d = a.d0 + (a.d1 - a.d0) * e;
    this.pos.copy(this.target).addScaledVector(this.forward(), -d);
    if (k >= 1) this.anim = null;
    this.dirty = true;
  }

  sceneBounds() {
    const box = new THREE.Box3();
    for (const g of [this.bodies, this.preview, this.sketches]) {
      g.traverse((o) => { if ((o.isMesh || o.isLine) && o.geometry) box.expandByObject(o); });
    }
    return box;
  }

  fit() {
    const box = this.sceneBounds();
    if (box.isEmpty()) { box.set(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 30)); }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const aspect = this.el.clientWidth / (this.el.clientHeight || 1);
    const half = THREE.MathUtils.degToRad(FOV / 2);
    const d = (sphere.radius / Math.sin(Math.min(half, Math.atan(Math.tan(half) * aspect)))) * 1.15;
    this.setView(this.forward(), new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat), Math.max(d, 1), sphere.center);
  }

  home() {
    const dir = new THREE.Vector3(-1, 1, -0.8).normalize();
    this.setView(dir, new THREE.Vector3(0, 0, 1));
    setTimeout(() => this.fit(), 360);
  }

  orbit(dx, dy, pivot) {
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -dx * 0.008);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(right, -dy * 0.008);
    const q = qYaw.multiply(qPitch);
    this.pos.sub(pivot).applyQuaternion(q).add(pivot);
    this.target.sub(pivot).applyQuaternion(q).add(pivot);
    this.quat.premultiply(q);
    this.redraw();
  }

  pan(dx, dy) {
    const upp = this.unitsPerPixel();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quat);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat);
    const move = right.multiplyScalar(-dx * upp).addScaledVector(up, dy * upp);
    this.pos.add(move);
    this.target.add(move);
    this.redraw();
  }

  zoomAt(ev, delta) {
    const factor = Math.exp(delta * 0.0012);
    const rc = this.ray(ev);
    const meshes = this.bodyData.filter((b) => b.mesh).map((b) => b.mesh);
    let p = rc.intersectObjects(meshes)[0]?.point;
    if (!p) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.forward(), this.target);
      p = rc.ray.intersectPlane(plane, new THREE.Vector3()) || this.target.clone();
    }
    const newDist = this.distance() * factor;
    if (newDist < 0.05 || newDist > 100000) return;
    this.pos.sub(p).multiplyScalar(factor).add(p);
    this.target.sub(p).multiplyScalar(factor).add(p);
    this.redraw();
  }

  setOrtho(on) { this.useOrtho = on; this.redraw(); }

  // ---------- events ----------

  bindEvents() {
    const dom = this.renderer.domElement;
    const tool = () => this.tool || this.idleTool;
    let drag = null;
    this.boxEl = document.createElement('div');
    this.boxEl.className = 'sel-box';
    this.boxEl.hidden = true;
    this.el.appendChild(this.boxEl);
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', (ev) => {
      dom.setPointerCapture(ev.pointerId);
      const orbit = (ev.button === 1 && ev.shiftKey) || (ev.button === 2 && !ev.shiftKey);
      const pan = (ev.button === 1 && !ev.shiftKey) || (ev.button === 2 && ev.shiftKey);
      if (orbit || pan) {
        ev.preventDefault();
        let pivot = this.target.clone();
        if (orbit) {
          const meshes = this.bodyData.filter((b) => b.mesh).map((b) => b.mesh);
          const hit = this.ray(ev).intersectObjects(meshes)[0];
          if (hit) pivot = hit.point.clone();
        }
        this.anim = null;
        drag = { mode: orbit ? 'orbit' : 'pan', x: ev.clientX, y: ev.clientY, x0: ev.clientX, y0: ev.clientY, button: ev.button, moved: false, pivot };
        dom.style.cursor = orbit ? 'grabbing' : 'move';
      } else if (ev.button === 0 && tool()?.onPointerDown?.(ev)) {
        drag = { mode: 'tool' };
      } else if (ev.button === 0) {
        drag = { mode: 'click', x: ev.clientX, y: ev.clientY, moved: false, box: false };
      }
    });
    dom.addEventListener('pointermove', (ev) => {
      if (drag?.mode === 'tool') { tool()?.onDrag?.(ev); return; }
      if (drag && drag.mode !== 'click') {
        if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) > 4) drag.moved = true;
        const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        drag.x = ev.clientX; drag.y = ev.clientY;
        if (drag.mode === 'orbit') this.orbit(dx, dy, drag.pivot); else this.pan(dx, dy);
        return;
      }
      if (drag?.mode === 'click') {
        if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) > 4) drag.moved = true;
        drag.box = drag.moved && !!tool()?.boxKind?.();
        if (drag.box) { this.showBox(drag, ev); return; }
      }
      tool()?.onMove?.(ev);
    });
    dom.addEventListener('pointerup', (ev) => {
      if (drag?.mode === 'click') {
        if (drag.box) this.finishBox(drag, ev, tool());
        else if (!drag.moved) tool()?.onClick?.(ev);
      }
      if (drag?.mode === 'tool') tool()?.onDragEnd?.(ev);
      // A middle press without moving is a click (selects a whole body); moving pans.
      if (drag?.button === 1 && !drag.moved) tool()?.onMiddleClick?.(ev);
      drag = null;
      dom.style.cursor = '';
    });
    dom.addEventListener('dblclick', (ev) => tool()?.onDblClick?.(ev));
    dom.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      this.anim = null;
      this.zoomAt(ev, ev.deltaY);
    }, { passive: false });
    dom.addEventListener('pointerleave', () => tool()?.onLeave?.());
  }

  boxRect(drag, ev) {
    return {
      x0: Math.min(drag.x, ev.clientX), x1: Math.max(drag.x, ev.clientX),
      y0: Math.min(drag.y, ev.clientY), y1: Math.max(drag.y, ev.clientY),
    };
  }

  // Selection box: solid when dragged left to right (window), dashed right to left (crossing).
  showBox(drag, ev) {
    const r = this.boxRect(drag, ev);
    const o = this.el.getBoundingClientRect();
    Object.assign(this.boxEl.style, {
      left: `${r.x0 - o.left}px`, top: `${r.y0 - o.top}px`, width: `${r.x1 - r.x0}px`, height: `${r.y1 - r.y0}px`,
    });
    this.boxEl.classList.toggle('crossing', ev.clientX < drag.x);
    this.boxEl.hidden = false;
  }

  finishBox(drag, ev, t) {
    this.boxEl.hidden = true;
    const kind = t?.boxKind?.();
    if (!kind) return;
    t.onBoxSelect?.(this.boxSelect(this.boxRect(drag, ev), ev.clientX < drag.x, kind), ev);
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.persp.aspect = w / h;
    this.redraw();
  }

  redraw() { this.dirty = true; }

  render() {
    const w = this.el.clientWidth, h = this.el.clientHeight || 1;
    const d = this.distance();
    for (const cam of [this.persp, this.ortho]) {
      cam.position.copy(this.pos);
      cam.quaternion.copy(this.quat);
    }
    this.persp.near = Math.max(0.01, d / 1000);
    this.persp.far = d * 1000 + 10000;
    this.persp.updateProjectionMatrix();
    const hh = d * Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    Object.assign(this.ortho, { left: -hh * (w / h), right: hh * (w / h), top: hh, bottom: -hh });
    this.ortho.updateProjectionMatrix();
    this.renderHooks.forEach((fn) => fn());
    this.headlight.position.copy(this.pos);
    this.headlight.target.position.copy(this.target).addScaledVector(new THREE.Vector3(1, 0.5, 0).applyQuaternion(this.quat), d * 0.3);
    this.renderer.render(this.scene, this.camera);
    this.onRender?.();
  }
}

export { COLORS };
