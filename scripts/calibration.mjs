// Calibration rows for train-head: pool indices whose key (`url\ntitle`, as finetune.py writes them to
// calibration.json) is in `keys`. Only these rows may pick the threshold and the override similarity.
export const rowKey = (r) => `${r.url}\n${r.title}`;
export function calibrationIndices(pool, keys) {
  const set = new Set(keys);
  return pool.flatMap((r, i) => (set.has(rowKey(r)) ? [i] : []));
}
/**
 * calibrationIndices, checked: every distinct key must match a pool row. A key-format drift or a pool change would
 * otherwise quietly shrink the calibration set, so zero matches always throws and a partial match throws unless
 * `allowPartial` (train-head: CALIBRATION_ALLOW_PARTIAL=1) is set. `file` names the keys file in the message.
 */
export function matchCalibration(pool, keys, { file = 'calibration keys', allowPartial = false } = {}) {
  const idx = calibrationIndices(pool, keys);
  const distinct = new Set(keys).size;
  if (!idx.length) throw new Error(`${file}: none of its ${keys.length} keys matches a pool row (key format \`url\\ntitle\`?)`);
  if (idx.length < distinct && !allowPartial) {
    throw new Error(
      `${file}: only ${idx.length} of its ${distinct} distinct keys match a pool row; the pool or the key format has ` +
        'drifted. Regenerate the keys, or set CALIBRATION_ALLOW_PARTIAL=1 to calibrate on the matched rows only.',
    );
  }
  return idx;
}
