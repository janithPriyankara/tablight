// Dashboard routing (location.hash) and the pure filters behind each view.
import type { GroupSummary, Item, SyncStatus } from '../../shared/types';

export const SPECIAL_VIEWS = ['all', 'unsorted', 'duplicates', 'stashed', 'sessions', 'settings'] as const;
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
export function viewHash(v: View): string {
  return v.kind === 'group' ? `group=${encodeURIComponent(v.id)}` : `view=${v.kind}`;
}
export function sameView(a: View, b: View): boolean {
  return a.kind === b.kind && (a.kind !== 'group' || a.id === (b as { id: string }).id);
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

/** Open and sleeping tabs by window then recency, then the stash newest first. */
export function byDefaultOrder(a: Item, b: Item): number {
  const sa = a.state === 'stashed' ? 1 : 0;
  const sb = b.state === 'stashed' ? 1 : 0;
  if (sa !== sb) return sa - sb;
  if (sa === 1) return (b.stashedAt ?? b.updatedAt) - (a.stashedAt ?? a.updatedAt);
  if ((a.windowId ?? 0) !== (b.windowId ?? 0)) return (a.windowId ?? 0) - (b.windowId ?? 0);
  return b.lastActiveAt - a.lastActiveAt;
}

/** The items a list view shows (sessions/settings show none). */
export function itemsForView(v: View, items: Item[], groups: GroupSummary[]): Item[] {
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
  return out.sort(byDefaultOrder);
}

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
