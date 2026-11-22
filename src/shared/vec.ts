/** Every component finite (no NaN or Infinity). */
export function isFiniteVector(v: ArrayLike<number>): boolean {
  for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return false;
  return true;
}
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  const c = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Number.isFinite(c) ? c : 0; // a NaN or Infinity anywhere matches nothing instead of poisoning a ranking
}
export function mean(vs: number[][]): number[] {
  if (vs.length === 0) return [];
  const first = vs[0] ?? [];
  const out = new Array<number>(first.length).fill(0);
  for (const v of vs) for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) + (v[i] ?? 0);
  return out.map((x) => x / vs.length);
}
export function normalize(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  if (!Number.isFinite(n)) return v.map(() => 0); // non-finite input: a zero vector, which matches nothing
  return n === 0 ? v.slice() : v.map((x) => x / n);
}
