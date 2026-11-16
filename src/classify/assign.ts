import type { Group } from '../shared/types';
import { cosine, mean, normalize } from '../shared/vec';
import { STARTER_GROUPS } from './seeds';

/**
 * Tuned on the dev fixture (tests/quality/fixture.json) with generic, brand-free seeds: the
 * spec's starting point (0.35) left most tabs Unsorted (MiniLM similarities between a short title
 * and a short topic description are low); 0.2 is where about half of misc ('other') pages stay
 * Unsorted. Lower values assign more real tabs but also force misc pages into wrong groups.
 */
export const DEFAULT_THRESHOLD = 0.2;
/**
 * k-NN k. Starter seeds are facets of a topic ("Gmail", "Jira ticket", "Zoom" are all Work);
 * a tab matches one or two of them, so averaging the top 5 dilutes the score with unrelated
 * facets. k=2 beat k=5 by about 3 points on the dev fixture. Overridable via opts.k.
 */
export const DEFAULT_K = 2;
export const MAX_EXEMPLARS = 50;
/** Never assigned automatically: only the user puts tabs in "Other". */
export const OTHER_GROUP_ID = 'other';

export interface Assignment {
  groupId: string | null;
  score: number;
}

function centroidOf(exemplars: number[][]): number[] | null {
  return exemplars.length ? normalize(mean(exemplars)) : null;
}

/** score(g) = 0.5 · cos(vec, centroid) + 0.5 · mean(top-k cos(vec, exemplar)). */
function scoreGroup(vec: ArrayLike<number>, g: Group, k: number): number | null {
  const centroid = g.centroid ?? centroidOf(g.exemplars);
  if (!centroid) return null;
  const c = cosine(vec, centroid);
  if (g.exemplars.length === 0) return c;
  const sims = g.exemplars.map((e) => cosine(vec, e)).sort((a, b) => b - a);
  const top = sims.slice(0, Math.max(1, k));
  return 0.5 * c + 0.5 * (top.reduce((s, x) => s + x, 0) / top.length);
}

export function assign(
  vec: ArrayLike<number>,
  groups: Group[],
  opts: { threshold?: number; k?: number } = {},
): Assignment {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const k = opts.k ?? DEFAULT_K;
  let best: Assignment = { groupId: null, score: 0 };
  for (const g of groups) {
    if (g.id === OTHER_GROUP_ID) continue;
    const s = scoreGroup(vec, g, k);
    if (s !== null && (best.groupId === null || s > best.score)) best = { groupId: g.id, score: s };
  }
  return best.score >= threshold ? best : { groupId: null, score: best.score };
}

/** Adds an exemplar (keeping the newest MAX_EXEMPLARS) and recomputes the centroid. Pure. */
export function learn(group: Group, vec: number[]): Group {
  const exemplars = [...group.exemplars, vec.slice()].slice(-MAX_EXEMPLARS);
  return { ...group, exemplars, centroid: centroidOf(exemplars) };
}

/** Embeds every starter seed in one call and returns the built-in groups. */
export async function buildStarterGroups(
  embedFn: (t: string[]) => Promise<Float32Array[]>,
): Promise<Group[]> {
  const texts = STARTER_GROUPS.flatMap((g) => g.seeds);
  const vecs = texts.length ? await embedFn(texts) : [];
  if (vecs.length !== texts.length) throw new Error('embedFn returned the wrong number of vectors');
  const now = Date.now();
  let i = 0;
  return STARTER_GROUPS.map((g) => {
    const exemplars = g.seeds.map(() => Array.from(vecs[i++]!));
    return {
      id: g.id, name: g.name, color: g.color, icon: g.icon, builtIn: true,
      exemplars, centroid: centroidOf(exemplars), createdAt: now,
    };
  });
}
