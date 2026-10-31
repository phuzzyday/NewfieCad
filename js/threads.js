// Thread sizes, shared by the panel and the kernel. Metric (ISO coarse) and unified
// (UNC / UNF) threads all have the same 60° profile, so one shape serves both.

const IN = 25.4;
const metric = (d, p) => ({ id: `M${d}`, label: `M${d} × ${p}`, d, p });
const unified = (name, inches, tpi, series) => ({ id: `${name}-${tpi}`, label: `${name}"-${tpi} ${series}`, d: inches * IN, p: IN / tpi });

export const THREADS = [
  metric(2, 0.4), metric(2.5, 0.45), metric(3, 0.5), metric(4, 0.7), metric(5, 0.8), metric(6, 1), metric(8, 1.25),
  metric(10, 1.5), metric(12, 1.75), metric(14, 2), metric(16, 2), metric(18, 2.5), metric(20, 2.5), metric(24, 3),
  metric(27, 3), metric(30, 3.5), metric(36, 4),
  unified('1/4', 0.25, 20, 'UNC'), unified('1/4', 0.25, 28, 'UNF'),
  unified('5/16', 0.3125, 18, 'UNC'), unified('5/16', 0.3125, 24, 'UNF'),
  unified('3/8', 0.375, 16, 'UNC'), unified('3/8', 0.375, 24, 'UNF'),
  unified('7/16', 0.4375, 14, 'UNC'), unified('7/16', 0.4375, 20, 'UNF'),
  unified('1/2', 0.5, 13, 'UNC'), unified('1/2', 0.5, 20, 'UNF'),
  unified('5/8', 0.625, 11, 'UNC'), unified('5/8', 0.625, 18, 'UNF'),
  unified('3/4', 0.75, 10, 'UNC'), unified('3/4', 0.75, 16, 'UNF'),
  unified('7/8', 0.875, 9, 'UNC'), unified('7/8', 0.875, 14, 'UNF'),
  unified('1', 1, 8, 'UNC'), unified('1', 1, 12, 'UNF'),
];

export const threadById = (id) => THREADS.find((t) => t.id === id) || null;

// The diameter a face should have for a thread: a shaft is the major diameter,
// a hole the minor diameter (the tap drill size, near enough).
export const fitDiameter = (t, internal) => (internal ? t.d - 1.0825 * t.p : t.d);

// The coarse size that best fits a round face.
export function nearestThread(diameter, internal) {
  let best = null, bestErr = Infinity;
  for (const t of THREADS) {
    if (t.label.endsWith('UNF')) continue;
    const err = Math.abs(fitDiameter(t, internal) - diameter);
    if (err < bestErr) { best = t; bestErr = err; }
  }
  return best;
}
