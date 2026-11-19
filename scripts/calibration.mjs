// Calibration rows for train-head: pool indices whose key (`url\ntitle`, as finetune.py writes them to
// calibration.json) is in `keys`. Only these rows may pick the threshold and the override similarity.
export const rowKey = (r) => `${r.url}\n${r.title}`;
export function calibrationIndices(pool, keys) {
  const set = new Set(keys);
  return pool.flatMap((r, i) => (set.has(rowKey(r)) ? [i] : []));
}
