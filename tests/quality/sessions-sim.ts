// Replays imagined people's browsing sessions through the product pipeline, to check the neighbour step.
import { buildStarterGroups, buildTrainedGroup, headTop, learn, OTHER_GROUP_ID, TRAINED_IDS } from '../../src/classify/assign';
import { neighbourGroup, pickGroup, VIDEOS_GROUP_ID, type Neighbour, type NeighbourOpts, type PlacedBy } from '../../src/classify/pick';
import { embedText, normalizeUrl } from '../../src/shared/url';
import type { Group } from '../../src/shared/types';
import { loadProductModel, type QualityHead } from './model';

export interface SessionRow { person: string; title: string; url: string; group: string }
/** Counts over the tabs the pipeline placed (user-placed tabs are not scored). */
export interface SimResult {
  /** Non-`other` tabs: in their own group, in another group, left Unsorted. */
  right: number;
  wrong: number;
  unsorted: number;
  total: number;
  /** `other` tabs, and how many of them were put in a group. */
  others: number;
  otherAssigned: number;
}
export interface SimOpts {
  /** 'shipped': pickGroup with the pool (the product path); constants: the same step with these values; null: no pool. */
  neighbours: 'shipped' | NeighbourOpts | null;
  /** The share of each person's tabs the user places by hand, with their true group (default USER_SHARE). */
  userShare?: number;
  /** Each seed is one replay (a different share placed by the user); counts are summed over them. */
  seeds?: number[];
  /** Called for every tab the pipeline placed (including `other` rows), with the group it chose (null: Unsorted). */
  record?: (row: SessionRow, groupId: string | null) => void;
  /**
   * Every person has every group (installed plus all on-demand groups), not only the on-demand groups their own
   * rows are labelled with, so a tab can land in any label's group (default false: the quality sets' design).
   */
  allGroups?: boolean;
}
/** The default share of each person's tabs the user places by hand. */
export const USER_SHARE = 0.3;
/**
 * The two scenarios the neighbour step is tuned and gated on: a profile filled by automatic placements alone (the
 * pool is rule, exemplar and head placements; nothing taught), and one where the user placed 30% by hand (which
 * also teaches exemplars). The first has no randomness: its replays are identical, kept so both weigh the same.
 */
export const SCENARIOS = [
  { name: 'auto only (0% by hand)', userShare: 0 },
  { name: `${USER_SHARE * 100}% by hand`, userShare: USER_SHARE },
] as const;
export const SEEDS = [1, 2, 3, 4, 5];
/** Placements that never count as neighbours (tab-index neighbourPool). */
const GUESSES: ReadonlySet<PlacedBy> = new Set<PlacedBy>(['neighbour', 'youtube', 'videos']);

/** mulberry32, seeded by the replay seed and the person, so each person's hand-placed tabs are fixed per seed. */
function rng(seed: number, person: string): () => number {
  let a = seed;
  for (let i = 0; i < person.length; i++) a = Math.imul(a ^ person.charCodeAt(i), 2654435761);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** right − 2 × (wrong + `other` tabs put in a group): an `other` tab pulled into a group costs like a wrong group. */
export const score = (r: SimResult): number => r.right - 2 * (r.wrong + r.otherAssigned);

/**
 * Loads the real model and head once. `simulate` then replays each person's rows in order: a seeded `userShare` of
 * tabs are placed by the user in their true group (which teaches that group, as a drag does: moveItems → learn);
 * the rest go through pickGroup with the pool so far. Each person has the installed groups plus every on-demand
 * group their rows are labelled with (so their on-demand topics can be reached, as after the interests step), or,
 * with `allGroups`, every group.
 */
export async function loadSessionSim(): Promise<{
  head: QualityHead;
  simulate: (rows: SessionRow[], opts: SimOpts) => Promise<SimResult>;
}> {
  const { head, embed } = await loadProductModel();
  const starter = await buildStarterGroups(embed);
  const trained = new Map((await Promise.all([...TRAINED_IDS].map((id) => buildTrainedGroup(id, embed)))).map((g) => [g.id, g]));
  const vecCache = new Map<string, Float32Array>();
  async function vectors(rows: SessionRow[]): Promise<Float32Array[]> {
    const texts = rows.map((r) => embedText(r));
    const todo = [...new Set(texts.filter((t) => !vecCache.has(t)))];
    if (todo.length) (await embed(todo)).forEach((v, k) => vecCache.set(todo[k]!, v));
    return texts.map((t) => vecCache.get(t)!);
  }
  // pickGroup without a pool depends only on the row and the groups, which the user's placements (fixed per seed
  // and share) decide: the sweep computes it once per share, seed and row, not once per setting.
  const baseCache = new WeakMap<SessionRow[], Map<string, ReturnType<typeof pickGroup>>>();
  /** Whether the head's top label for a vector is `other` (depends on the vector alone). */
  const readsOther = new WeakMap<Float32Array, boolean>();
  function pick(
    key: string, cache: Map<string, ReturnType<typeof pickGroup>>, row: SessionRow, vec: Float32Array, groups: Group[],
    pool: Neighbour[], opts: SimOpts['neighbours'],
  ) {
    if (opts === 'shipped') return pickGroup(row, vec, groups, head, pool);
    let base = cache.get(key);
    if (!base) cache.set(key, (base = pickGroup(row, vec, groups, head)));
    // The neighbour step runs exactly where and when pickGroup runs it: after rule, exemplar and head found nothing,
    // and never for a tab the head reads as `other`.
    if (opts === null || (base.by !== null && base.by !== 'youtube' && base.by !== 'videos')) return base;
    let other = readsOther.get(vec);
    if (other === undefined) readsOther.set(vec, (other = headTop(vec, head)?.label === OTHER_GROUP_ID));
    if (other) return base;
    const near = neighbourGroup(vec, pool, groups, opts);
    return near === null ? base : { groupId: near, want: null, by: 'neighbour' as const };
  }
  async function simulate(rows: SessionRow[], opts: SimOpts): Promise<SimResult> {
    const vecs = await vectors(rows);
    const share = opts.userShare ?? USER_SHARE;
    const everyGroup = opts.allGroups ? [...starter, ...trained.values()] : null;
    let cache = baseCache.get(rows);
    if (!cache) baseCache.set(rows, (cache = new Map()));
    const out: SimResult = { right: 0, wrong: 0, unsorted: 0, total: 0, others: 0, otherAssigned: 0 };
    const people = [...new Set(rows.map((r) => r.person))];
    for (const seed of opts.seeds ?? SEEDS) {
      for (const person of people) {
        const mine = rows.flatMap((r, k) => (r.person === person ? [{ r, v: vecs[k]!, k }] : []));
        const needed = new Set(mine.map(({ r }) => r.group).filter((g) => TRAINED_IDS.has(g)));
        let groups: Group[] = everyGroup ?? [...starter, ...[...needed].map((id) => trained.get(id)!)];
        const pool: Neighbour[] = []; // newest first, as neighbourPool orders it
        const rand = rng(seed, person);
        for (const { r, v, k } of mine) {
          const normUrl = normalizeUrl(r.url);
          if (rand() < share && groups.some((g) => g.id === r.group)) {
            groups = groups.map((g) => (g.id === r.group ? learn(g, Array.from(v)) : g));
            if (r.group !== VIDEOS_GROUP_ID && r.group !== OTHER_GROUP_ID) pool.unshift({ vec: v, groupId: r.group, normUrl });
            continue;
          }
          const { groupId, by } = pick(`${share}:${seed}:${k}${everyGroup ? ':all' : ''}`, cache, r, v, groups, pool, opts.neighbours);
          if (groupId !== null && by !== null && !GUESSES.has(by) && groupId !== VIDEOS_GROUP_ID && groupId !== OTHER_GROUP_ID) {
            pool.unshift({ vec: v, groupId, normUrl });
          }
          opts.record?.(r, groupId);
          if (r.group === OTHER_GROUP_ID) {
            out.others++;
            if (groupId !== null) out.otherAssigned++;
            continue;
          }
          out.total++;
          if (groupId === r.group) out.right++;
          else if (groupId === null) out.unsorted++;
          else out.wrong++;
        }
      }
    }
    return out;
  }
  return { head, simulate };
}
