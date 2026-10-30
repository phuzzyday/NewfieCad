// Mesh simplification by quadric edge collapse (after Sven Forstmann's
// "Fast Quadric Mesh Simplification", MIT licence). Repeatedly merges the two ends
// of the edge whose removal changes the surface least, skipping merges that would
// flip a triangle, until the target triangle count is reached.

// Symmetric 4x4 error matrix, stored as its 10 distinct entries.
const plane = (a, b, c, d) => [a * a, a * b, a * c, a * d, b * b, b * c, b * d, c * c, c * d, d * d];
const addQ = (q, r) => q.map((v, i) => v + r[i]);
const det = (m, a11, a12, a13, a21, a22, a23, a31, a32, a33) =>
  m[a11] * m[a22] * m[a33] + m[a13] * m[a21] * m[a32] + m[a12] * m[a23] * m[a31] -
  m[a13] * m[a22] * m[a31] - m[a11] * m[a23] * m[a32] - m[a12] * m[a21] * m[a33];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function vertexError(q, [x, y, z]) {
  return q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y +
    2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9];
}

// mesh: { positions: Float32Array, indices: Uint32Array }. Returns a new mesh.
export function simplifyMesh(mesh, target, onProgress = () => {}) {
  const V = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    V.push({ p: [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]], q: null, tstart: 0, tcount: 0, border: false });
  }
  let T = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    T.push({ v: [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]], err: [0, 0, 0, 0], deleted: false, dirty: false, n: [0, 0, 0] });
  }
  let refs = []; // { tid, tvertex }

  const calcError = (i0, i1, out) => {
    const q = addQ(V[i0].q, V[i1].q);
    const border = V[i0].border && V[i1].border;
    const d = det(q, 0, 1, 2, 1, 4, 5, 2, 5, 7);
    if (d !== 0 && !border) {
      out[0] = (-1 / d) * det(q, 1, 2, 3, 4, 5, 6, 5, 7, 8);
      out[1] = (1 / d) * det(q, 0, 2, 3, 1, 5, 6, 2, 7, 8);
      out[2] = (-1 / d) * det(q, 0, 1, 3, 1, 4, 6, 2, 5, 8);
      return vertexError(q, out);
    }
    const p1 = V[i0].p, p2 = V[i1].p, p3 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2];
    const e = [vertexError(q, p1), vertexError(q, p2), vertexError(q, p3)];
    const best = Math.min(...e);
    const p = best === e[0] ? p1 : best === e[1] ? p2 : p3;
    out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
    return best;
  };

  const triErrors = (t) => {
    const tmp = [0, 0, 0];
    for (let j = 0; j < 3; j++) t.err[j] = calcError(t.v[j], t.v[(j + 1) % 3], tmp);
    t.err[3] = Math.min(t.err[0], t.err[1], t.err[2]);
  };

  // Would moving vertex i0 (merging with i1) to p flip any of its other triangles?
  const flipped = (p, i1, v0, deleted) => {
    for (let k = 0; k < v0.tcount; k++) {
      const r = refs[v0.tstart + k];
      const t = T[r.tid];
      if (t.deleted) continue;
      const id1 = t.v[(r.tvertex + 1) % 3], id2 = t.v[(r.tvertex + 2) % 3];
      if (id1 === i1 || id2 === i1) { deleted[k] = true; continue; }
      const d1 = norm(sub(V[id1].p, p)), d2 = norm(sub(V[id2].p, p));
      if (Math.abs(dot(d1, d2)) > 0.999) return true;
      deleted[k] = false;
      if (dot(norm(cross(d1, d2)), t.n) < 0.2) return true;
    }
    return false;
  };

  let deletedCount = 0;
  const updateTriangles = (i0, v, deleted) => {
    const tmp = [0, 0, 0];
    for (let k = 0; k < v.tcount; k++) {
      const r = refs[v.tstart + k];
      const t = T[r.tid];
      if (t.deleted) continue;
      if (deleted[k]) { t.deleted = true; deletedCount++; continue; }
      t.v[r.tvertex] = i0;
      t.dirty = true;
      for (let j = 0; j < 3; j++) t.err[j] = calcError(t.v[j], t.v[(j + 1) % 3], tmp);
      t.err[3] = Math.min(t.err[0], t.err[1], t.err[2]);
      refs.push(r);
    }
  };

  const updateMesh = (iteration) => {
    if (iteration > 0) T = T.filter((t) => !t.deleted);
    for (const v of V) { v.tstart = 0; v.tcount = 0; }
    for (const t of T) for (const i of t.v) V[i].tcount++;
    let start = 0;
    for (const v of V) { v.tstart = start; start += v.tcount; v.tcount = 0; }
    refs = new Array(T.length * 3);
    T.forEach((t, i) => t.v.forEach((vi, j) => { const v = V[vi]; refs[v.tstart + v.tcount] = { tid: i, tvertex: j }; v.tcount++; }));
    if (iteration !== 0) return;

    // Vertices on an open edge are borders: they only merge with other border vertices.
    for (const [vi, v] of V.entries()) {
      const counts = new Map();
      for (let k = 0; k < v.tcount; k++) {
        for (const id of T[refs[v.tstart + k].tid].v) if (id !== vi) counts.set(id, (counts.get(id) || 0) + 1);
      }
      for (const [id, c] of counts) if (c === 1) V[id].border = true;
    }
    for (const v of V) v.q = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const t of T) {
      const [p0, p1, p2] = t.v.map((i) => V[i].p);
      t.n = norm(cross(sub(p1, p0), sub(p2, p0)));
      const pl = plane(t.n[0], t.n[1], t.n[2], -dot(t.n, p0));
      for (const i of t.v) V[i].q = addQ(V[i].q, pl);
    }
    for (const t of T) triErrors(t);
  };

  const start = T.length;
  const p = [0, 0, 0];
  for (let iteration = 0; iteration < 100; iteration++) {
    if (T.length - deletedCount <= target) break;
    if (iteration % 5 === 0) { updateMesh(iteration); deletedCount = 0; }
    onProgress((start - (T.length - deletedCount)) / Math.max(1, start - target));
    for (const t of T) t.dirty = false;
    // The error allowed grows each pass, so cheap merges happen first.
    const threshold = 1e-9 * (iteration + 3) ** 7;
    for (const t of T) {
      if (t.err[3] > threshold || t.deleted || t.dirty) continue;
      for (let j = 0; j < 3; j++) {
        if (t.err[j] >= threshold) continue;
        const i0 = t.v[j], i1 = t.v[(j + 1) % 3];
        const v0 = V[i0], v1 = V[i1];
        if (v0.border !== v1.border) continue;
        calcError(i0, i1, p);
        const del0 = new Array(v0.tcount).fill(false), del1 = new Array(v1.tcount).fill(false);
        if (flipped(p, i1, v0, del0) || flipped(p, i0, v1, del1)) continue;
        v0.p = [p[0], p[1], p[2]];
        v0.q = addQ(v1.q, v0.q);
        const tstart = refs.length;
        updateTriangles(i0, v0, del0);
        updateTriangles(i0, v1, del1);
        const tcount = refs.length - tstart;
        if (tcount <= v0.tcount) {
          // Reuse v0's slot in the reference list.
          for (let k = 0; k < tcount; k++) refs[v0.tstart + k] = refs[tstart + k];
          refs.length = tstart;
        } else {
          v0.tstart = tstart;
        }
        v0.tcount = tcount;
        break;
      }
      if (T.length - deletedCount <= target) break;
    }
  }

  // Compact: keep live triangles and the vertices they use.
  const live = T.filter((t) => !t.deleted);
  const remap = new Int32Array(V.length).fill(-1);
  const pos = [];
  for (const t of live) {
    for (const i of t.v) if (remap[i] < 0) { remap[i] = pos.length / 3; pos.push(...V[i].p); }
  }
  const idx = new Uint32Array(live.length * 3);
  live.forEach((t, k) => { for (let j = 0; j < 3; j++) idx[k * 3 + j] = remap[t.v[j]]; });
  return { positions: new Float32Array(pos), indices: idx };
}
