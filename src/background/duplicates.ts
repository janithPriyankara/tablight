import type { Item } from '../shared/types';
import type { Db } from './db';

/** Neutral grey: the badge is information, not an alarm. */
export const BADGE_COLOR = '#6f6e77';
/** Burnt orange: shown only while suspicious tabs are open. */
export const BADGE_ALERT_COLOR = '#c2410c';

/** normUrl → the ≥ 2 open/sleeping web items sharing it. Stashed and non-web items never count. */
export function findDuplicates(items: Item[]): Map<string, Item[]> {
  const by = new Map<string, Item[]>();
  for (const i of items) {
    if (i.state === 'stashed' || !i.classifiable || i.tabId === undefined) continue;
    const list = by.get(i.normUrl);
    if (list) list.push(i);
    else by.set(i.normUrl, [i]);
  }
  for (const [k, list] of by) if (list.length < 2) by.delete(k);
  return by;
}

/** tabId → badge text we last set. Lets a full refresh touch only tabs whose text changes. */
const shown = new Map<number, string>();
let mode: 'alert' | 'normal' | undefined;
let shownTitle: string | undefined;
const MODE_KEY = 'badgeMode';
async function loadMode(): Promise<'alert' | 'normal' | undefined> {
  try {
    const v = (await chrome.storage.session.get(MODE_KEY))[MODE_KEY] as unknown;
    return v === 'alert' || v === 'normal' ? v : undefined;
  } catch {
    return undefined;
  }
}
async function saveMode(m: 'alert' | 'normal'): Promise<void> {
  try {
    await chrome.storage.session.set({ [MODE_KEY]: m });
  } catch {
    // best effort
  }
}
/** Forget what we set on these tabs (Chrome may reset a tab's badge, e.g. when it navigates). */
export function invalidateBadges(tabIds: number[]): void {
  for (const id of tabIds) shown.delete(id);
}
/** For tests and a fresh worker. */
export function resetBadgeCache(): void {
  shown.clear();
  mode = undefined;
  shownTitle = undefined;
}
/**
 * Per-tab badge: "!" on every tab while `suspiciousCount` > 0, otherwise "2×" (the copy count) on a tab that has
 * a duplicate and '' elsewhere. With `activeTabId` that tab is always (re)set. Without it, every indexed tab is
 * checked but setBadgeText is called only where the text differs from what we last set (unknown counts as '').
 * The colour is set only when the mode (alert/normal) flips; a flip rewrites every tab, even with `activeTabId`.
 */
export async function updateBadge(db: Db, activeTabId?: number, suspiciousCount = 0): Promise<void> {
  const items = (await db.items.all()).filter((i) => i.state !== 'stashed' && i.tabId !== undefined);
  const count = new Map<number, number>();
  for (const list of findDuplicates(items).values()) for (const i of list) count.set(i.tabId!, list.length);
  const alert = suspiciousCount > 0;
  const textOf = (tabId: number) => {
    if (alert) return '!';
    const n = count.get(tabId);
    return n ? `${n}×` : '';
  };
  const want = alert ? 'alert' : 'normal';
  // Chrome keeps badge text across worker restarts, so the last mode is remembered in session storage.
  if (mode === undefined) mode = await loadMode();
  // No remembered mode (fresh browser): badges are empty, i.e. 'normal' as far as tab text goes, but the colour is still set.
  const flipped = (mode ?? 'normal') !== want;
  if (mode !== want) {
    const prev = mode;
    mode = want;
    void saveMode(want);
    shown.clear(); // every tab needs the new mode's text
    await chrome.action
      .setBadgeBackgroundColor({ color: alert ? BADGE_ALERT_COLOR : BADGE_COLOR })
      .catch(() => (mode = prev));
  }
  const title = alert ? `Tablight: ${suspiciousCount} suspicious ${suspiciousCount === 1 ? 'tab' : 'tabs'}` : 'Tablight';
  if (shownTitle !== title) {
    shownTitle = title;
    await chrome.action.setTitle({ title }).catch(() => (shownTitle = undefined));
  }
  let targets: number[];
  if (activeTabId !== undefined && !flipped) targets = [activeTabId];
  else {
    const live = new Set(items.map((i) => i.tabId!));
    for (const id of shown.keys()) if (!live.has(id)) shown.delete(id);
    // A mode flip rewrites every tab: the old per-tab text (cleared above) is not known to be ''.
    targets = [...live].filter((id) => flipped || (shown.get(id) ?? '') !== textOf(id));
  }
  await Promise.all(
    targets.map(async (tabId) => {
      const text = textOf(tabId);
      try {
        await chrome.action.setBadgeText({ tabId, text });
        shown.set(tabId, text);
      } catch {
        shown.delete(tabId); // the tab closed since the index was read: not an error
      }
    }),
  );
}
