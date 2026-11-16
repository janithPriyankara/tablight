// Memory actions: sleep (discard), stash (persist then close), open, close, close extras, undo.
import { sha1hex } from '../shared/hash';
import type { Item } from '../shared/types';
import { isSafeToOpen, isWebUrl } from '../shared/url';
import type { Db } from './db';
import { findDuplicates } from './duplicates';
export const AUTO_SLEEP_ALARM = 'auto-sleep';
export const UNDO_MS = 10_000;
interface Closed {
  item: Item;
  url: string;
  windowId: number | undefined;
  pinned: boolean;
  /** Stash record this action created for the tab (merged ones pre-existed and are kept on undo). */
  createdStash?: string;
}
interface UndoEntry {
  expires: number;
  closed: Closed[];
}
// In memory only: a service-worker restart forgets pending undos, which is acceptable for a 10 s window.
const undos = new Map<string, UndoEntry>();
function remember(entry: Omit<UndoEntry, 'expires'>): string {
  const now = Date.now();
  for (const [k, v] of undos) if (v.expires <= now) undos.delete(k);
  const token = crypto.randomUUID();
  undos.set(token, { ...entry, expires: now + UNDO_MS });
  return token;
}
const hasTab = (i: Item): i is Item & { tabId: number } => i.state !== 'stashed' && i.tabId !== undefined;
async function liveTabs(): Promise<Map<number, chrome.tabs.Tab>> {
  return new Map((await chrome.tabs.query({})).flatMap((t) => (t.id === undefined ? [] : [[t.id, t] as const])));
}
/** Discards the given items' tabs. Skips active, pinned, audible, already-discarded and non-web tabs. */
export async function sleepTabs(db: Db, ids: string[]): Promise<{ slept: number; skipped: number }> {
  const live = await liveTabs();
  let slept = 0;
  let skipped = 0;
  for (const id of ids) {
    const item = await db.items.get(id);
    const tab = item && hasTab(item) ? live.get(item.tabId) : undefined;
    if (!item || !tab || tab.active || tab.pinned || tab.audible || tab.discarded || !isWebUrl(tab.url ?? '')) {
      skipped++;
      continue;
    }
    try {
      await chrome.tabs.discard(tab.id!);
      slept++;
    } catch {
      skipped++; // the tab closed or cannot be discarded
    }
  }
  return { slept, skipped };
}
/** Sleeps open tabs that were inactive for settings.autoSleepMinutes. Returns how many slept. */
export async function autoSleep(db: Db, now: number): Promise<number> {
  const minutes = (await db.settings.get()).autoSleepMinutes;
  if (minutes === null) return 0;
  const cutoff = now - minutes * 60_000;
  const stale = (await db.items.byState('open')).filter((i) => i.lastActiveAt < cutoff).map((i) => i.id);
  return stale.length ? (await sleepTabs(db, stale)).slept : 0;
}
/** Re-attaches a recreated tab to the item it came from, so the group survives undo/open. */
async function adopt(db: Db, item: Item, tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  await db.tx(['items'], async (s) => {
    const existing = await s.items.byTabId(tab.id!);
    if (existing) {
      // A reconcile got there first: it only knows the auto classification, so restore the group.
      if (existing.groupSource === 'auto' && existing.normUrl === item.normUrl && item.groupId !== null) {
        await s.items.put({ ...existing, groupId: item.groupId, groupSource: item.groupSource });
      }
      return;
    }
    await s.items.put({
      ...item, state: 'open', tabId: tab.id!, windowId: tab.windowId, lastActiveAt: Date.now(), updatedAt: Date.now(),
    });
  });
}
/** Creates a tab in its window; falls back to the current window when that one is gone. */
async function createTab(url: string, windowId: number | undefined, pinned = false): Promise<chrome.tabs.Tab> {
  const props = { url, active: false, pinned };
  if (windowId !== undefined) {
    try {
      return await chrome.tabs.create({ ...props, windowId });
    } catch { /* window closed */ }
  }
  return chrome.tabs.create(props);
}
/**
 * Stashes web tabs: the stash record is persisted (replacing the open item) BEFORE the tab closes, so
 * a failing close never loses a tab. Non-web tabs (they could never be reopened) are skipped.
 */
export async function stash(db: Db, ids: string[]): Promise<{ token: string; skipped: number }> {
  const live = await liveTabs();
  const uniqueIds = new Set(ids);
  const picked: { item: Item & { tabId: number }; stashId: string }[] = [];
  for (const id of uniqueIds) {
    const item = await db.items.get(id);
    if (item && hasTab(item) && isWebUrl(item.url)) picked.push({ item, stashId: await sha1hex(item.normUrl) });
  }
  const now = Date.now();
  const createdStash = new Set<string>();
  await db.tx(['items', 'queue'], async (s) => {
    for (const { item, stashId } of picked) {
      const prev = await s.items.get(stashId);
      const keepGroup = prev?.groupSource === 'user' && item.groupSource === 'auto';
      const rec: Item = {
        id: stashId, groupId: keepGroup ? prev.groupId : item.groupId,
        groupSource: keepGroup ? 'user' : item.groupSource,
        kind: item.kind, title: item.title || prev?.title || '', url: item.url, normUrl: item.normUrl,
        domain: item.domain, state: 'stashed', createdAt: prev?.createdAt ?? item.createdAt,
        lastActiveAt: item.lastActiveAt, stashedAt: Math.min(prev?.stashedAt ?? now, now), updatedAt: now,
        classifiable: item.classifiable,
      };
      if (!prev) createdStash.add(stashId);
      await s.items.put(rec);
      await s.items.delete(item.id);
      await s.queue.remove([item.id]);
    }
  });
  const closed: Closed[] = picked.map(({ item, stashId }) => ({
    item, url: item.url, windowId: item.windowId, pinned: live.get(item.tabId)?.pinned ?? false,
    ...(createdStash.has(stashId) ? { createdStash: stashId } : {}),
  }));
  const done = await removeTabs(closed.map((c, k) => [c, picked[k]!.item.tabId] as const));
  // Tabs that could not close stay stashed too (and stay out of the undo entry, so undo never
  // deletes their record); the next reconcile re-adds an open item for them.
  return { token: remember({ closed: done }), skipped: uniqueIds.size - picked.length };
}
async function removeTabs(entries: (readonly [Closed, number])[]): Promise<Closed[]> {
  const done: Closed[] = [];
  for (const [c, tabId] of entries) {
    try {
      await chrome.tabs.remove(tabId);
      done.push(c);
    } catch { /* already gone */ }
  }
  return done;
}
export async function closeTabs(db: Db, ids: string[]): Promise<{ token: string }> {
  const live = await liveTabs();
  const entries: (readonly [Closed, number])[] = [];
  for (const id of new Set(ids)) {
    const item = await db.items.get(id);
    if (!item || !hasTab(item)) continue;
    entries.push([{ item, url: live.get(item.tabId)?.url || item.url, windowId: item.windowId,
      pinned: live.get(item.tabId)?.pinned ?? false }, item.tabId]);
  }
  return { token: remember({ closed: await removeTabs(entries) }) };
}
/** Closes duplicate tabs, keeping the most recently active copy of each page. */
export async function closeExtras(db: Db): Promise<{ closed: number; token: string }> {
  const live = await liveTabs();
  // Keep a pinned copy, else the active one, else the most recently active.
  const rank = (i: Item) => {
    const t = i.tabId === undefined ? undefined : live.get(i.tabId);
    return [t?.pinned ? 1 : 0, t?.active ? 1 : 0, i.lastActiveAt];
  };
  const better = (a: Item, b: Item) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let k = 0; k < 3; k++) if (ra[k] !== rb[k]) return rb[k]! > ra[k]!;
    return false;
  };
  const ids: string[] = [];
  for (const group of findDuplicates(await db.items.all()).values()) {
    const keep = group.reduce((a, b) => (better(a, b) ? b : a));
    for (const i of group) if (i !== keep) ids.push(i.id);
  }
  const { token } = await closeTabs(db, ids);
  return { closed: undos.get(token)?.closed.length ?? 0, token };
}
export async function openItem(db: Db, id: string): Promise<void> {
  const item = await db.items.get(id);
  if (!item) throw new Error('item not found');
  if (item.state !== 'stashed') {
    if (item.tabId === undefined) throw new Error('tab no longer exists');
    try {
      await chrome.tabs.update(item.tabId, { active: true });
    } catch {
      throw new Error('tab no longer exists');
    }
    // The tab is already active; failing to raise its window must not fail the open.
    if (item.windowId !== undefined) await chrome.windows.update(item.windowId, { focused: true }).catch(() => undefined);
    return;
  }
  if (!isSafeToOpen(item.url)) throw new Error('unsafe url');
  const tab = await chrome.tabs.create({ url: item.url, active: true });
  const remove = (await db.settings.get()).removeOnOpen;
  if (remove) {
    await db.tx(['items', 'tombstones'], async (s) => {
      await s.items.delete(item.id);
      await s.tombstones.put({ id: item.id, deletedAt: Date.now() });
    });
  }
  await adopt(db, { ...item, id: crypto.randomUUID(), stashedAt: undefined }, tab);
}
/** Within UNDO_MS of the action: reopens closed web tabs / un-stashes. Returns false when too late. */
export async function undo(db: Db, token: string): Promise<boolean> {
  const e = undos.get(token);
  if (!e) return false;
  undos.delete(token);
  if (e.expires <= Date.now()) return false;
  const restored: string[] = [];
  for (const c of e.closed) {
    if (!isWebUrl(c.url)) continue;
    try {
      const tab = await createTab(c.url, c.windowId, c.pinned);
      if (c.createdStash) restored.push(c.createdStash); // only once the tab is back
      await adopt(db, c.item, tab);
    } catch (err) {
      console.error('undo could not reopen a tab', err);
    }
  }
  if (restored.length) {
    await db.tx(['items'], async (s) => {
      for (const id of restored) if ((await s.items.get(id))?.state === 'stashed') await s.items.delete(id);
    });
  }
  return true;
}
