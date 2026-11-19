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
 * trained 2026-11-19 (pool 5002): the highest bar of the plateau where right − 2 × wrong peaks (81/90 topic videos
 * in their group, 58/59 no-topic in Videos, 1 wrong, the same as any bar down to 0; 78/90 at 0.36).
 * youtube-messy.json is the honest score. Re-measure it when the head is retrained.
 */
export const YOUTUBE_THRESHOLD = 0.26;
/** One of the owner's grouped tabs that an unsure tab may follow (tab-index neighbourPool builds the pool). */
export interface Neighbour {
  vec: ArrayLike<number>;
  groupId: string;
  normUrl: string;
}
/**
 * The neighbour step: an unsure tab goes where its closest grouped tabs are. Of the NEIGHBOUR_K pool tabs closest
 * to it at cosine ≥ NEIGHBOUR_SIMILARITY (one vote per page), a group with at least NEIGHBOUR_MIN votes and
 * strictly more than any other wins.
 * Chosen on training/sessions-tune.json (tests/quality/neighbours.test.ts) by the sum of right − 2 × wrong over two
 * scenarios: a profile filled by automatic placements alone, and one where the user placed 30% of tabs by hand
 * (teaching their groups, as a drag does), 5 replays each. The grid was similarity 0.50–0.80 × min {2, 3} × k {5, 10},
 * with the head trained 2026-11-19. 0.52 / 2 / 10 scores 1067: automatic only 605 (1405 right, 400 wrong,
 * 200 Unsorted of 2005) and 30% by hand 462 (1016, 277, 126 of 1419). Without neighbours the sum is 875
 * (505: 1295 / 395 / 315, and 370: 922 / 276 / 221). From 0.70 up the step never fires. tests/quality/sessions.json is
 * the blind gate.
 */
export const NEIGHBOUR_SIMILARITY = 0.52;
export const NEIGHBOUR_MIN = 2;
export const NEIGHBOUR_K = 10;
/** The pool holds at most this many tabs (most recently active first): 100 picks against it stay well under 1.5 s. */
export const NEIGHBOUR_POOL_MAX = 2000;
export interface NeighbourOpts { similarity: number; min: number; k: number }
const SHIPPED: NeighbourOpts = { similarity: NEIGHBOUR_SIMILARITY, min: NEIGHBOUR_MIN, k: NEIGHBOUR_K };
/**
 * The group the closest pool tabs agree on, or null. Tabs in a group missing from `groups` (or in Other / Videos)
 * and vectors of another length are skipped. `opts` exists for tuning (tests/quality/sessions-sim.ts).
 */
export function neighbourGroup(
  vec: ArrayLike<number>, pool: Neighbour[], groups: Group[], opts: NeighbourOpts = SHIPPED,
): string | null {
  const known = new Set(groups.map((g) => g.id));
  // The closest tab of each page, at or above the similarity bar.
  const best = new Map<string, { s: number; groupId: string }>();
  for (const n of pool) {
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
 * (user-taught exemplars, then the trained head at its threshold) > the neighbour step over `pool` > for a YouTube
 * video, the head's top topic at the lower YOUTUBE_THRESHOLD, else Videos (when it exists) > null. `by` says which.
 * `want` is the head's topic when no group exists for it yet and the head is that sure of it (`threshold`, for
 * pages and videos alike): the lower YouTube bar only places a video into a group that already exists.
 * `groups` must exclude suggested groups; `pool` must exclude the item itself.
 */
export function pickGroup(
  item: Pick<Item, 'url' | 'title'>,
  vec: ArrayLike<number>,
  groups: Group[],
  head: Head,
  pool: Neighbour[] = [],
): { groupId: string | null; want: string | null; by: PlacedBy | null } {
  // A rule, an exemplar, the head or neighbours decided: nothing is wanted. `want` is only for tabs left Unsorted
  // or parked in Videos.
  const rule = ruleGroup(item.url, item.title);
  if (rule !== null && groups.some((g) => g.id === rule)) return { groupId: rule, want: null, by: 'rule' };
  const picked = classify(vec, groups, head);
  if (picked.groupId !== null) return { groupId: picked.groupId, want: null, by: picked.by ?? 'head' };
  const near = pool.length ? neighbourGroup(vec, pool, groups) : null;
  if (near !== null) return { groupId: near, want: null, by: 'neighbour' };
  const video = isYouTubeVideo(item.url);
  const bar = video ? Math.min(YOUTUBE_THRESHOLD, head.threshold) : head.threshold;
  const top = headTop(vec, head);
  const label = top?.label !== undefined && top.label !== OTHER_GROUP_ID && top.score >= bar ? top.label : null;
  if (label !== null && groups.some((g) => g.id === label)) return { groupId: label, want: null, by: video ? 'youtube' : 'head' };
  const wanted = label !== null && top !== null && top.score >= head.threshold ? label : null;
  if (video && groups.some((g) => g.id === VIDEOS_GROUP_ID)) return { groupId: VIDEOS_GROUP_ID, want: wanted, by: 'videos' };
  return { groupId: null, want: wanted, by: null };
}
