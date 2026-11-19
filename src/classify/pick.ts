import type { Group, Item } from '../shared/types';
import { isYouTubeVideo } from '../shared/url';
import { classify, headTop, OTHER_GROUP_ID, type Head } from './assign';
import { ruleGroup } from './rules';
export const VIDEOS_GROUP_ID = 'videos';
/**
 * The automatic pipeline for one embedded item: ruleGroup (only when that group exists) > classify
 * (trained head + user-taught exemplars) > YouTube watch page into Videos (when it exists) > null.
 * `want` is the head's confident topic when no group exists for it yet. `groups` must exclude suggested groups.
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
  const top = headTop(vec, head);
  const want =
    top?.label !== undefined && top.label !== OTHER_GROUP_ID && top.score >= head.threshold &&
    !groups.some((g) => g.id === top.label)
      ? top.label
      : null;
  if (isYouTubeVideo(item.url) && groups.some((g) => g.id === VIDEOS_GROUP_ID)) return { groupId: VIDEOS_GROUP_ID, want };
  return { groupId: null, want };
}
