import type { Group, Item } from '../shared/types';
import { isYouTubeVideo } from '../shared/url';
import { classify, headTop, OTHER_GROUP_ID, type Head } from './assign';
import { ruleGroup } from './rules';
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
/**
 * The automatic pipeline for one embedded item: ruleGroup (only when that group exists) > classify
 * (trained head + user-taught exemplars) > for a YouTube video, the head's top topic at the lower
 * YOUTUBE_THRESHOLD, else Videos (when it exists) > null.
 * `want` is the head's topic when no group exists for it yet and the head is that sure of it (`threshold`, for
 * pages and videos alike): the lower YouTube bar only places a video into a group that already exists.
 * `groups` must exclude suggested groups.
 */
export function pickGroup(
  item: Pick<Item, 'url' | 'title'>,
  vec: ArrayLike<number>,
  groups: Group[],
  head: Head,
): { groupId: string | null; want: string | null } {
  // A rule or an exemplar decided: nothing is wanted. `want` is only for tabs left Unsorted or parked in Videos.
  const rule = ruleGroup(item.url, item.title);
  if (rule !== null && groups.some((g) => g.id === rule)) return { groupId: rule, want: null };
  const picked = classify(vec, groups, head).groupId;
  if (picked !== null) return { groupId: picked, want: null };
  const video = isYouTubeVideo(item.url);
  const bar = video ? Math.min(YOUTUBE_THRESHOLD, head.threshold) : head.threshold;
  const top = headTop(vec, head);
  const label = top?.label !== undefined && top.label !== OTHER_GROUP_ID && top.score >= bar ? top.label : null;
  if (label !== null && groups.some((g) => g.id === label)) return { groupId: label, want: null };
  const wanted = label !== null && top !== null && top.score >= head.threshold ? label : null;
  if (video && groups.some((g) => g.id === VIDEOS_GROUP_ID)) return { groupId: VIDEOS_GROUP_ID, want: wanted };
  return { groupId: null, want: wanted };
}
