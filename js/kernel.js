// Main-thread wrapper around the kernel worker. Only the newest request of each
// channel is kept, so fast edits don't queue up stale rebuilds.

export class Kernel {
  constructor(onStatus) {
    this.onStatus = onStatus;
    this.nextId = 1;
    this.pending = new Map();
    this.busy = false;
    this.queued = null;
    this.sentMeshes = new Set(); // imported STL data the worker already has
    this.ready = new Promise((resolve, reject) => {
      this.worker = new Worker(new URL('./kernel-worker.js', import.meta.url), { type: 'module' });
      this.worker.onerror = (e) => {
        onStatus('error', 'Geometry kernel failed to load. Check that the lib folder is complete (run fetch_libs.py), then reload.');
        reject(e);
      };
      this.worker.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.type === 'ready') { onStatus('ready'); resolve(); return; }
        if (msg.type === 'init-error') { onStatus('error', `Kernel error: ${msg.error}`); reject(msg.error); return; }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        this.busy = false;
        if (msg.type === 'failed') { onStatus('failed', msg.error); p.resolve(null); } else p.resolve(msg);
        this._drain();
        if (!this.busy) onStatus('idle');
      };
    });
  }

  // Rebuild; resolves with the result, or null if a newer request replaced this one.
  // `request.meshes` holds all imported STLs; each is only sent to the worker once.
  build(request) {
    return new Promise((resolve, reject) => {
      if (this.queued) this.queued.resolve(null);
      this.queued = { request, resolve, reject };
      this.ready.then(() => this._drain(), () => {});
    });
  }

  _drain() {
    if (this.busy || !this.queued) return;
    const { request, resolve, reject } = this.queued;
    this.queued = null;
    this.busy = true;
    const id = this.nextId++;
    this.pending.set(id, { resolve, reject });
    this.onStatus('busy');
    const meshes = {};
    for (const [mid, data] of Object.entries(request.meshes || {})) {
      if (!this.sentMeshes.has(mid)) { meshes[mid] = data; this.sentMeshes.add(mid); }
    }
    this.worker.postMessage({ type: 'build', id, ...request, meshes });
  }
}
