/**
 * Stand-in for src/background/embedder.ts in the UI preview (swapped in by vite.preview.config.ts).
 * Looks texts up in the precomputed vectors; unknown text gets a deterministic hash-based unit vector.
 */
import vectors from './fixtures.vectors.json';
const table = vectors.vectors as Record<string, number[]>;
function unit(v: number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}
function hashVector(text: string, dim: number): Float32Array {
  let a = 2166136261;
  for (let i = 0; i < text.length; i++) a = Math.imul(a ^ text.charCodeAt(i), 16777619) >>> 0;
  const v: number[] = [];
  for (let i = 0; i < dim; i++) {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    v.push(((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5);
  }
  return unit(v);
}
export function isWarm(): boolean {
  return true;
}
export async function embed(texts: string[]): Promise<Float32Array[]> {
  await new Promise((r) => setTimeout(r, 15)); // a little latency, like the real model
  return texts.map((t) => {
    const known = table[t];
    return known ? unit(known) : hashVector(t, vectors.dim);
  });
}
