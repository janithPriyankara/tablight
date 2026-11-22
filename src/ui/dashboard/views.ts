// Dashboard routing (location.hash) and the pure filters behind each view.
import type { GroupSummary, Item, SyncStatus } from '../../shared/types';
import { PRIORITY_GROUP_ID } from '../../shared/priority';

export const SPECIAL_VIEWS = ['all', 'unsorted', 'duplicates', 'suspicious', 'stashed', 'sessions', 'settings'] as const;
export type SpecialView = (typeof SPECIAL_VIEWS)[number];
export type View = { kind: SpecialView } | { kind: 'group'; id: string };

/** "#group=<encoded id>" or "#view=<name>"; anything else is the All view. */
export function parseHash(hash: string): View {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const group = params.get('group');
  if (group) return { kind: 'group', id: group.slice(0, 200) };
  const view = params.get('view');
  return (SPECIAL_VIEWS as readonly string[]).includes(view ?? '') ? { kind: view as SpecialView } : { kind: 'all' };
}
/** The Settings page's tabs, in order. The open one is `tab=<id>` in the hash; General has no parameter. */
export const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'sync', label: 'Sync & backup' },
  { id: 'privacy', label: 'Privacy & data' },
  { id: 'help', label: 'Help & about' },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]['id'];
/** The Settings tab a hash names; missing or unknown values (old links, typos) open General. */
export function parseSettingsTab(hash: string): SettingsTab {
  const tab = new URLSearchParams(hash.replace(/^#/, '')).get('tab');
  return SETTINGS_TABS.find((t) => t.id === tab)?.id ?? 'general';
}
export function settingsHash(tab: SettingsTab): string {
  return tab === 'general' ? 'view=settings' : `view=settings&tab=${tab}`;
}
const UNDO_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * "#view=stashed&undo=<uuid>&n=<count>", left by the popup's "Stash this window": the undo token (a UUID,
 * anything else is ignored) and how many tabs were stashed. The undo itself still goes through the RPC.
 */
export function parseUndoHash(hash: string): { token: string; n: number } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = params.get('undo');
  const n = Number(params.get('n'));
  if (token === null || !UNDO_TOKEN_RE.test(token) || !Number.isSafeInteger(n) || n < 0 || n > 100_000) return null;
  return { token, n };
}
export function viewHash(v: View): string {
  return v.kind === 'group' ? `group=${encodeURIComponent(v.id)}` : `view=${v.kind}`;
}
export function sameView(a: View, b: View): boolean {
  return a.kind === b.kind && (a.kind !== 'group' || a.id === (b as { id: string }).id);
}

/**
 * The user's groups as every list shows them (dashboard sidebar and View menu, side panel): Priority first, then by
 * size, then by name. Priority is left out while it is empty, unless it is the group on screen (`openId`).
 * Suggestions are not included.
 */
export function regularGroups(groups: GroupSummary[], openId?: string): GroupSummary[] {
  const rank = (g: GroupSummary) => (g.id === PRIORITY_GROUP_ID ? 0 : 1);
  return groups
    .filter((g) => !g.suggested && (g.id !== PRIORITY_GROUP_ID || g.count > 0 || g.id === openId))
    .sort((a, b) => rank(a) - rank(b) || b.count - a.count || a.name.localeCompare(b.name));
}
/** Every copy of a page open more than once (same rule as the background's findDuplicates). */
export function duplicateItems(items: Item[]): Item[] {
  const by = new Map<string, Item[]>();
  for (const i of items) {
    if (i.state === 'stashed' || !i.classifiable || i.tabId === undefined) continue;
    const list = by.get(i.normUrl);
    if (list) list.push(i);
    else by.set(i.normUrl, [i]);
  }
  return [...by.values()].filter((l) => l.length > 1).flat();
}

/**
 * Duplicates view: open copies of pages the view listed earlier (`seen`, normalized URLs) that are no longer
 * duplicates. Closing one of two copies would otherwise drop both rows, as if every copy had gone; the copy left
 * stays listed (marked "Last copy, still open") until the view changes.
 */
export function lastCopies(listed: Item[], items: Item[], seen: ReadonlySet<string>): Item[] {
  const still = new Set(listed.map((i) => i.normUrl));
  return items.filter((i) => i.state !== 'stashed' && i.classifiable && i.tabId !== undefined &&
    seen.has(i.normUrl) && !still.has(i.normUrl));
}
/** Open and sleeping tabs by window then recency, then the stash newest first. */
const STATE_RANK: Record<Item['state'], number> = { open: 0, sleeping: 1, stashed: 2 };
/**
 * Open tabs first, most recently used at the top whatever their window; then paused tabs the same way; then
 * saved-for-later items, newest saved first. Rows still say which window a tab is in.
 */
export function byDefaultOrder(a: Item, b: Item): number {
  const byState = STATE_RANK[a.state] - STATE_RANK[b.state];
  if (byState !== 0) return byState;
  if (a.state === 'stashed') return (b.stashedAt ?? b.updatedAt) - (a.stashedAt ?? a.updatedAt);
  return b.lastActiveAt - a.lastActiveAt;
}

/**
 * The items a list view shows (sessions/settings show none; suspicious has its own list). `now`: the tab ids that
 * are the active tab of their window; those come first.
 */
export function itemsForView(v: View, items: Item[], groups: GroupSummary[], now: ReadonlySet<number> = NO_TABS): Item[] {
  const known = new Set(groups.map((g) => g.id));
  let out: Item[];
  switch (v.kind) {
    case 'all': out = items.slice(); break;
    case 'unsorted': out = items.filter((i) => i.groupId === null || !known.has(i.groupId)); break;
    case 'stashed': out = items.filter((i) => i.state === 'stashed'); break;
    case 'duplicates': return duplicateItems(items).sort((a, b) => a.normUrl.localeCompare(b.normUrl) || byDefaultOrder(a, b));
    case 'group': out = items.filter((i) => i.groupId === v.id); break;
    default: return [];
  }
  const isNow = (i: Item) => (i.state === 'open' && i.tabId !== undefined && now.has(i.tabId) ? 0 : 1);
  return out.sort((a, b) => isNow(a) - isNow(b) || byDefaultOrder(a, b));
}
const NO_TABS: ReadonlySet<number> = new Set();

/** Windows numbered 1..n in id order ("Window 2"). */
export function windowNumbers(items: Item[]): Map<number, number> {
  const ids = [...new Set(items.flatMap((i) => (i.state !== 'stashed' && i.windowId !== undefined ? [i.windowId] : [])))];
  return new Map(ids.sort((a, b) => a - b).map((id, n) => [id, n + 1]));
}

/** "Synced 412 · 37 only on this device", or the failure's message. */
export function syncStatusLine(s: SyncStatus): string {
  if (!s.ok) return s.message;
  if (s.lastSyncAt === null) return 'Not synced yet';
  return s.localOnly ? `Synced ${s.synced} · ${s.localOnly} only on this device` : `Synced ${s.synced}`;
}

/** Local date as YYYY-MM-DD (export file names). */
export function isoDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
