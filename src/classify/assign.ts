import type { Group } from '../shared/types';
import { cosine, mean, normalize } from '../shared/vec';
import { STARTER_GROUPS } from './seeds';

export const MAX_EXEMPLARS = 50;
/** Never assigned automatically: only the user puts tabs in "Other". */
export const OTHER_GROUP_ID = 'other';

export interface Assignment {
  groupId: string | null;
  score: number;
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
  /** Below this top-class probability the tab stays Unsorted. */
  threshold: number;
  /** Cosine to a user-learned exemplar at which that group overrides the head. */
  similarity: number;
}

function softmax(z: number[]): number[] {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

/**
 * Picks a group for an embedded tab. Run after the caller's user-group and ruleGroup checks.
 * 1. User learning: if the tab is at least `similarity` close to an exemplar a user taught a
 *    group (drag / learn()), the closest such group wins. User-created groups work this way alone.
 * 2. Otherwise the head's top label, unless it is `other`, below `threshold`, or not among `groups`.
 * `other` is never assigned automatically.
 */
export function classify(
  vec: ArrayLike<number>,
  groups: Group[],
  head: Head,
  opts: { threshold?: number; similarity?: number } = {},
): Assignment {
  const similarity = opts.similarity ?? head.similarity;
  let near: Assignment = { groupId: null, score: -Infinity };
  for (const g of groups) {
    if (g.id === OTHER_GROUP_ID) continue;
    for (const e of g.exemplars) {
      const s = cosine(vec, e);
      if (s > near.score) near = { groupId: g.id, score: s };
    }
  }
  if (near.groupId !== null && near.score >= similarity) return near;

  if (vec.length !== head.dim) return { groupId: null, score: 0 };
  const x = Array.from(vec);
  const p = softmax(head.W.map((row, c) => row.reduce((s, w, d) => s + w * x[d]!, head.b[c] ?? 0)));
  let top = 0;
  for (let c = 1; c < p.length; c++) if (p[c]! > p[top]!) top = c;
  const label = head.labels[top];
  const score = p[top] ?? 0;
  const ok =
    label !== undefined && label !== OTHER_GROUP_ID && score >= (opts.threshold ?? head.threshold) &&
    groups.some((g) => g.id === label);
  return { groupId: ok ? label : null, score };
}

function centroidOf(exemplars: number[][]): number[] | null {
  return exemplars.length ? normalize(mean(exemplars)) : null;
}

/** Adds a user-taught exemplar (keeping the newest MAX_EXEMPLARS) and recomputes the centroid. Pure. */
export function learn(group: Group, vec: number[]): Group {
  const exemplars = [...group.exemplars, vec.slice()].slice(-MAX_EXEMPLARS);
  return { ...group, exemplars, centroid: centroidOf(exemplars) };
}

/**
 * Builds the built-in groups. Seeds are embedded once (one call) only to give each group an
 * initial centroid for clustering, naming and search; they are not exemplars and do not drive
 * assignment (the head does). `exemplars` holds user-learned vectors only.
 */
export async function buildStarterGroups(
  embedFn: (t: string[]) => Promise<Float32Array[]>,
): Promise<Group[]> {
  const texts = STARTER_GROUPS.flatMap((g) => g.seeds);
  const vecs = texts.length ? await embedFn(texts) : [];
  if (vecs.length !== texts.length) throw new Error('embedFn returned the wrong number of vectors');
  const now = Date.now();
  let i = 0;
  return STARTER_GROUPS.map((g) => {
    const seedVecs = g.seeds.map(() => Array.from(vecs[i++]!));
    return {
      id: g.id, name: g.name, color: g.color, icon: g.icon, builtIn: true,
      exemplars: [], centroid: centroidOf(seedVecs), createdAt: now,
    };
  });
}
