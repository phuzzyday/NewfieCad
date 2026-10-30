// Runs mesh simplification off the main thread so the page stays responsive.

import { simplifyMesh } from './simplify.js';

self.onmessage = (ev) => {
  const { positions, indices, target } = ev.data;
  try {
    let last = 0;
    const m = simplifyMesh({ positions, indices }, target, (f) => {
      if (f - last > 0.05) { last = f; self.postMessage({ type: 'progress', value: Math.min(1, f) }); }
    });
    self.postMessage({ type: 'done', positions: m.positions, indices: m.indices }, [m.positions.buffer, m.indices.buffer]);
  } catch (e) {
    self.postMessage({ type: 'error', error: e?.message || String(e) });
  }
};
