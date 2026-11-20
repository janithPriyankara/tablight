import type { Group, Item, PlacedBy } from '../shared/types';
import { isYouTubeVideo } from '../shared/url';
import { cosine } from '../shared/vec';
import { classify, headTop, OTHER_GROUP_ID, type Head } from './assign';
import { ruleGroup } from './rules';
export type { PlacedBy };
export const VIDEOS_GROUP_ID = 'videos';
/**
 * The lower bar a YouTube video's top topic must reach (head.threshold for pages). A video's title is short and
 * often messy ("#cdrama #shorts", clickbait, "Talk — Speaker (Conf)"), so its topic scores lower than a page's,
 * and without a topic it would only be parked in Videos. Chosen on tests/quality/youtube-topics.json with the head
 * retrained 2026-11-19 (pool 6202, with the messy-title set, so Videos means a video with no subject): the highest bar
 * of the plateau where right − 2 × wrong peaks (84/90 topic videos in their group, 59/59 no-topic in Videos, 0 wrong,
 * the same at every bar down to 0 and up to 0.27; 83/90 at 0.28). 0.26 sits on that plateau (0 to 0.27) of the
 * tuning set; 0.27 is as good there and differed only by noise-sized amounts elsewhere (one video parked, a few
 * points on the tuning sessions), so 0.26 was kept. youtube-messy.json is not a tuning input: it is the honest
 * score. Re-measure it when the head is retrained. A head may carry its own `youtubeThreshold` (an encoder with
 * another score scale, scripts/tune-youtube-bar.mjs); the shipped head for tablight/bge-small-tabs-v1 does (0.13), so
 * this constant is the fallback for a head without a valid one (youtubeBar).
 */
export const YOUTUBE_THRESHOLD = 0.26;
/**
 * The bar a YouTube video's top topic must reach: the head's own `youtubeThreshold` when it is a finite number in
 * [0, 1] (anything else, such as a missing, NaN, negative or string value, falls back to YOUTUBE_THRESHOLD), never
 * above head.threshold.
 */
export function youtubeBar(head: Pick<Head, 'threshold' | 'youtubeThreshold'>): number {
  const own: unknown = head.youtubeThreshold;
  const bar = typeof own === 'number' && Number.isFinite(own) && own >= 0 && own <= 1 ? own : YOUTUBE_THRESHOLD;
  return Math.min(bar, head.threshold);
}
/** One of the owner's grouped tabs that an unsure tab may follow (tab-index neighbourPool builds the pool). */
export interface Neighbour {
  /** The item's id, so a caller can leave the tab it is picking for out (NeighbourOpts.skipId). */
  id?: string;
  vec: ArrayLike<number>;
  groupId: string;
  normUrl: string;
}
/**
 * The neighbour step: an unsure tab goes where its closest grouped tabs are. Of the NEIGHBOUR_K pool tabs closest
 * to it at cosine ≥ head.similarity (one vote per page), a group with at least NEIGHBOUR_MIN votes and strictly
 * more than any other wins. It never runs for a tab the head reads as `other`.
 * The bar is head.similarity, the cosine scripts/train-head.mjs validates for the learned-exemplar override: a single
 * nearest pool item at that cosine is in the right group at least 95% of the time (head.similarity, read from head.json: currently 0.74). Two agreeing
 * tabs at that bar are stronger evidence still. The bar was not tuned on the synthetic sessions: lower bars chosen
 * there did not hold up blind (tests/quality/README.md). On those sessions the step rarely fires at this bar, but
 * real profiles repeat pages and sites far more, and that is where it helps. tests/quality/neighbours.test.ts checks
 * it does no harm.
 */
export const NEIGHBOUR_MIN = 2;
export const NEIGHBOUR_K = 10;
/** The pool holds at most this many tabs (most recently active first): 100 picks against it stay well under 1.5 s. */
export const NEIGHBOUR_POOL_MAX = 2000;
export interface NeighbourOpts { similarity: number; min: number; k: number; skipId?: string }
/**
 * The group the closest pool tabs agree on, or null. Tabs in a group missing from `groups` (or in Other / Videos)
 * and vectors of another length are skipped. pickGroup passes head.similarity, NEIGHBOUR_MIN and NEIGHBOUR_K; other
 * values are for the diagnostic sweep (tests/quality/sessions-sim.ts).
 */
export function neighbourGroup(
  vec: ArrayLike<number>, pool: Neighbour[], groups: Group[], opts: NeighbourOpts,
): string | null {
  const known = new Set(groups.map((g) => g.id));
  // The closest tab of each page, at or above the similarity bar.
  const best = new Map<string, { s: number; groupId: string }>();
  for (const n of pool) {
    if (opts.skipId !== undefined && n.id === opts.skipId) continue;
    if (n.vec.length !== vec.length || !known.has(n.groupId)) continue;
    if (n.groupId === OTHER_GROUP_ID || n.groupId === VIDEOS_GROUP_ID) continue;
    const s = cosine(vec, n.vec);
    if (s < opts.similarity) continue;
    const had = best.get(n.normUrl);
    if (!had || s > had.s) best.set(n.normUrl, { s, groupId: n.groupId });
  }
  const votes = new Map<string, number>();
  for (const { groupId } of [...best.values()].sort((a, b) => b.s - a.s).slice(0, opts.k)) {
    votes.set(groupId, (votes.get(groupId) ?? 0) + 1);
  }
  let top: string | null = null;
  let most = 0;
  let tie = false;
  for (const [g, n] of votes) {
    if (n > most) [top, most, tie] = [g, n, false];
    else if (n === most) tie = true;
  }
  return top !== null && !tie && most >= opts.min ? top : null;
}
/**
 * The automatic pipeline for one embedded item: ruleGroup (only when that group exists) > classify
 * (user-taught exemplars, then the trained head at its threshold) > the neighbour step over `pool` (never for a
 * tab whose head top label is `other`) > for a YouTube video, the head's top topic at the lower YOUTUBE_THRESHOLD,
 * else Videos (when it exists) > null. `by` says which.
 * `want` is the head's topic when no group exists for it yet and the head is that sure of it (`threshold`, for
 * pages and videos alike): the lower YouTube bar only places a video into a group that already exists.
 * `groups` must exclude suggested groups; `skipId` is the item's own id, left out of `pool`.
 */
export function pickGroup(
  item: Pick<Item, 'url' | 'title'>,
  vec: ArrayLike<number>,
  groups: Group[],
  head: Head,
  pool: Neighbour[] = [],
  skipId?: string,
): { groupId: string | null; want: string | null; by: PlacedBy | null } {
  // A rule, an exemplar, the head or neighbours decided: nothing is wanted. `want` is only for tabs left Unsorted
  // or parked in Videos.
  const rule = ruleGroup(item.url, item.title);
  if (rule !== null && groups.some((g) => g.id === rule)) return { groupId: rule, want: null, by: 'rule' };
  const picked = classify(vec, groups, head);
  if (picked.groupId !== null) return { groupId: picked.groupId, want: null, by: picked.by ?? 'head' };
  const top = headTop(vec, head);
  // A tab the head reads as `other` is never pulled into a group by its neighbours: only the user files those.
  const near = pool.length && top?.label !== OTHER_GROUP_ID
    ? neighbourGroup(vec, pool, groups, { similarity: head.similarity, min: NEIGHBOUR_MIN, k: NEIGHBOUR_K, skipId })
    : null;
  if (near !== null) return { groupId: near, want: null, by: 'neighbour' };
  const video = isYouTubeVideo(item.url);
  const bar = video ? youtubeBar(head) : head.threshold;
  const label = top?.label !== undefined && top.label !== OTHER_GROUP_ID && top.score >= bar ? top.label : null;
  if (label !== null && groups.some((g) => g.id === label)) return { groupId: label, want: null, by: video ? 'youtube' : 'head' };
  const wanted = label !== null && top !== null && top.score >= head.threshold ? label : null;
  if (video && groups.some((g) => g.id === VIDEOS_GROUP_ID)) return { groupId: VIDEOS_GROUP_ID, want: wanted, by: 'videos' };
  return { groupId: null, want: wanted, by: null };
}
