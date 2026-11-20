import type { Group } from '../shared/types';
import { cosine, mean, normalize } from '../shared/vec';
import { STARTER_GROUPS, type StarterGroup } from './seeds';

export const MAX_EXEMPLARS = 50;
/** Never assigned automatically: only the user puts tabs in "Other". */
export const OTHER_GROUP_ID = 'other';

export interface Assignment {
  groupId: string | null;
  score: number;
  /** What decided, when a group was picked: a user-taught exemplar or the head. */
  by?: 'exemplar' | 'head';
}

/**
 * Trained classification head (scripts/train-head.mjs → src/classify/head.json):
 * multinomial logistic regression over the sentence embedding.
 */
export interface Head {
  model: string;
  dim: number;
  labels: string[];
  /** labels.length × dim */
  W: number[][];
  b: number[];
  /**
   * Below this top-class probability the tab stays Unsorted rather than being guessed into a group. Chosen at
   * train time by 5-fold cross-validation, counting a wrong group as twice as costly as Unsorted (0.41 as shipped).
   */
  threshold: number;
  /** Cosine to a user-learned exemplar at which that group overrides the head. */
  similarity: number;
  /**
   * Neighbour blend: scores = (1-alpha)·p_head + alpha·vote of the k nearest training items (weight
   * exp(sharp·cosine)). `vecs` is base64 of int8 vectors (x·127, row-major, `dim` per item); `labels[i]` is
   * item i's index into `labels`. Absent: head only.
   */
  knn?: { k: number; alpha: number; sharp: number; labels: number[]; vecs: string };
  /**
   * The YouTube bar for this head's score scale (pickGroup youtubeBar), chosen on calibration rows by
   * scripts/tune-youtube-bar.mjs (0.13 for the shipped tablight/bge-small-tabs-v1 head). Absent or not a number in
   * [0, 1]: pickGroup's YOUTUBE_THRESHOLD.
   */
  youtubeThreshold?: number;
}
interface Neighbours { vecs: Int8Array; labels: Int32Array; n: number }
const decoded = new WeakMap<Head, Neighbours | null>();
function neighbours(head: Head): Neighbours | null {
  if (decoded.has(head)) return decoded.get(head)!;
  let out: Neighbours | null = null;
  const k = head.knn;
  if (k && k.labels.length) {
    const bin = atob(k.vecs);
    const vecs = new Int8Array(bin.length);
    for (let i = 0; i < bin.length; i++) vecs[i] = (bin.charCodeAt(i) << 24) >> 24;
    const n = Math.min(k.labels.length, Math.floor(vecs.length / head.dim));
    out = { vecs, labels: Int32Array.from(k.labels.slice(0, n)), n };
  }
  decoded.set(head, out);
  return out;
}
/** Weighted vote of the k nearest training items (cosine via int8 dot / 127). */
function neighbourVote(vec: ArrayLike<number>, head: Head, nb: Neighbours): Float64Array {
  const { k, sharp } = head.knn!;
  const D = head.dim;
  const best: { s: number; y: number }[] = [];
  for (let i = 0; i < nb.n; i++) {
    let s = 0;
    const o = i * D;
    for (let d = 0; d < D; d++) s += vec[d]! * nb.vecs[o + d]!;
    s /= 127;
    if (best.length < k) best.push({ s, y: nb.labels[i]! });
    else if (s > best[best.length - 1]!.s) best[best.length - 1] = { s, y: nb.labels[i]! };
    else continue;
    best.sort((a, b) => b.s - a.s);
  }
  const v = new Float64Array(head.labels.length);
  let total = 0;
  for (const { s, y } of best) {
    const w = Math.exp(sharp * s);
    v[y] = (v[y] ?? 0) + w;
    total += w;
  }
  if (total > 0) for (let c = 0; c < v.length; c++) v[c] = v[c]! / total;
  return v;
}

function softmax(z: number[]): number[] {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

/** The head's top label and its blended probability; null when the vector doesn't fit the head. */
export function headTop(vec: ArrayLike<number>, head: Head): { label: string | undefined; score: number } | null {
  if (vec.length !== head.dim) return null;
  const x = Array.from(vec);
  let p = softmax(head.W.map((row, c) => row.reduce((s, w, d) => s + w * x[d]!, head.b[c] ?? 0)));
  const nb = neighbours(head);
  if (nb && head.knn) {
    const vote = neighbourVote(x, head, nb);
    const a = head.knn.alpha;
    p = p.map((pc, c) => (1 - a) * pc + a * vote[c]!);
  }
  let top = 0;
  for (let c = 1; c < p.length; c++) if (p[c]! > p[top]!) top = c;
  return { label: head.labels[top], score: p[top] ?? 0 };
}
/**
 * Picks a group for an embedded tab. Run after the caller's user-group and ruleGroup checks.
 * 1. User learning: the single closest user-taught exemplar (drag / learn()) overrides the head when its
 *    cosine is at least `similarity` (a best-exemplar match, not a k-NN vote). User-created groups work
 *    this way alone.
 * 2. Otherwise the head's top label, unless it is `other`, below `threshold` (0 as shipped, so in
 *    practice no cutoff), or not among `groups`. Such tabs stay Unsorted.
 * `other` is never assigned automatically.
 */
export function classify(
  vec: ArrayLike<number>,
  groups: Group[],
  head: Head,
  opts: { threshold?: number; similarity?: number } = {},
): Assignment {
  const near = exemplarPick(vec, groups, head, opts.similarity);
  if (near) return { ...near, by: 'exemplar' };
  return headPick(vec, groups, head, opts.threshold);
}
/**
 * Step 1 of classify alone: the group of the single closest user-taught exemplar (never `other`) when its cosine is
 * at least `similarity` (head.similarity by default), else null.
 */
export function exemplarPick(
  vec: ArrayLike<number>,
  groups: Group[],
  head: Pick<Head, 'similarity'>,
  similarity = head.similarity,
): { groupId: string; score: number } | null {
  let near: { groupId: string | null; score: number } = { groupId: null, score: -Infinity };
  for (const g of groups) {
    if (g.id === OTHER_GROUP_ID) continue;
    for (const e of g.exemplars) {
      const s = cosine(vec, e);
      if (s > near.score) near = { groupId: g.id, score: s };
    }
  }
  return near.groupId !== null && near.score >= similarity ? { groupId: near.groupId, score: near.score } : null;
}
/** Step 2 of classify alone: the head's top label at `threshold`, when that group exists and is not `other`. */
export function headPick(vec: ArrayLike<number>, groups: Group[], head: Head, threshold = head.threshold): Assignment {
  const top = headTop(vec, head);
  if (!top) return { groupId: null, score: 0 };
  const { label, score } = top;
  if (
    label === undefined || label === OTHER_GROUP_ID || score < threshold ||
    !groups.some((g) => g.id === label)
  ) return { groupId: null, score };
  return { groupId: label, score, by: 'head' };
}

function centroidOf(exemplars: number[][]): number[] | null {
  return exemplars.length ? normalize(mean(exemplars)) : null;
}

/** Adds a user-taught exemplar (keeping the newest MAX_EXEMPLARS) and recomputes the centroid. Pure. */
export function learn(group: Group, vec: number[]): Group {
  const exemplars = [...group.exemplars, vec.slice()].slice(-MAX_EXEMPLARS);
  return { ...group, exemplars, centroid: centroidOf(exemplars) };
}

/** The ids of the on-demand groups (seeds flagged `onDemand`): created only when picked or needed, never at install. */
export const TRAINED_IDS: ReadonlySet<string> = new Set(STARTER_GROUPS.filter((g) => g.onDemand).map((g) => g.id));
/** Embeds the seeds of `seeds` once (one call) and builds each group with a centroid from its own seed vectors. */
async function buildGroups(
  seeds: StarterGroup[],
  embedFn: (t: string[]) => Promise<Float32Array[]>,
): Promise<Group[]> {
  const texts = seeds.flatMap((g) => g.seeds);
  const vecs = texts.length ? await embedFn(texts) : [];
  if (vecs.length !== texts.length) throw new Error('embedFn returned the wrong number of vectors');
  const now = Date.now();
  let i = 0;
  return seeds.map((g) => {
    const seedVecs = g.seeds.map(() => Array.from(vecs[i++]!));
    return {
      id: g.id, name: g.name, color: g.color, icon: g.icon, builtIn: true,
      exemplars: [], centroid: centroidOf(seedVecs), createdAt: now,
    };
  });
}
/**
 * Builds the groups created at install (every seed not flagged `onDemand`). Seeds are embedded once (one call)
 * only to give each group an initial centroid for clustering, naming and search; they are not exemplars and do
 * not drive assignment (the head does). `exemplars` holds user-learned vectors only.
 */
export function buildStarterGroups(
  embedFn: (t: string[]) => Promise<Float32Array[]>,
): Promise<Group[]> {
  return buildGroups(STARTER_GROUPS.filter((g) => !g.onDemand), embedFn);
}
/**
 * Builds one group from its seeds, the same way as the starter groups: an on-demand group when it is picked, or
 * an installed group the user deleted and wants back. Throws on an id that is not a seed group.
 */
export async function buildTrainedGroup(
  id: string,
  embedFn: (t: string[]) => Promise<Float32Array[]>,
): Promise<Group> {
  const seed = STARTER_GROUPS.find((g) => g.id === id);
  if (!seed) throw new Error(`unknown group id: ${id}`);
  return (await buildGroups([seed], embedFn))[0]!;
}
