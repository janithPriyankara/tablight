// Session snapshots: web tabs (url + title) per window, kept local only. Separate from the stash.
import { sha1hex } from '../shared/hash';
import type { Item, Snapshot } from '../shared/types';
import { isSafeToOpen, isWebUrl, kindOf, normalizeUrl } from '../shared/url';
import type { Db } from './db';
import { stashRecord } from './memory';
import { domainOf } from './tab-index';
export const SNAPSHOT_ALARM = 'snapshot';
export const SNAPSHOT_PERIOD_MINUTES = 60;
export const MAX_SNAPSHOTS = 14;
/** openAll asks for confirmation above this many tabs. */
export const OPEN_ALL_CONFIRM_ABOVE = 20;
/** Fewer than this share of the last snapshot's pages open at startup → the windows were not restored. */
export const RESTORED_THRESHOLD = 0.3;
/** chrome.storage.session: `{ snapshotId: string | null }` written by the startup check, read by the dashboard. */
export const LAST_SESSION_KEY = 'lastSession';
/** chrome.storage.session: set on browser startup until the startup check finished (survives worker restarts). */
export const STARTUP_PENDING_KEY = 'startupPending';
export interface SessionSummary { id: string; takenAt: number; windows: number; tabs: number }
const tabUrl = (t: chrome.tabs.Tab) => t.url || t.pendingUrl || '';
/** Same ordered normalized URLs per window → same session. */
function fingerprint(windows: Snapshot['windows']): string {
  return windows.map((w) => w.tabs.map((t) => normalizeUrl(t.url)).join('\n')).join('\n--\n');
}
const newest = (all: Snapshot[]): Snapshot | undefined => all.reduce<Snapshot | undefined>(
  (a, b) => (!a || b.takenAt >= a.takenAt ? b : a), undefined);
/**
 * Snapshots the open web tabs and keeps the newest MAX_SNAPSHOTS. A snapshot identical to the latest
 * one is not stored again (the latest is returned), and neither is one with no web tab at all (the
 * unsaved empty snapshot is returned).
 */
export async function takeSnapshot(db: Db, now: number): Promise<Snapshot> {
  const byWindow = new Map<number, { url: string; title: string }[]>();
  for (const t of await chrome.tabs.query({})) {
    const url = tabUrl(t);
    if (!isWebUrl(url)) continue;
    const list = byWindow.get(t.windowId) ?? [];
    list.push({ url, title: t.title ?? '' });
    byWindow.set(t.windowId, list);
  }
  const snapshot: Snapshot = {
    id: crypto.randomUUID(), takenAt: now, windows: [...byWindow.values()].map((tabs) => ({ tabs })),
  };
  if (!snapshot.windows.length) return snapshot;
  return db.tx(['snapshots'], async (s) => {
    const all = await s.snapshots.all();
    const latest = newest(all);
    if (latest && fingerprint(latest.windows) === fingerprint(snapshot.windows)) return latest;
    await s.snapshots.put(snapshot);
    const sorted = [...all, snapshot].sort((a, b) => b.takenAt - a.takenAt);
    for (const old of sorted.slice(MAX_SNAPSHOTS)) await s.snapshots.delete(old.id);
    return snapshot;
  });
}
/** The latest snapshot when fewer than 30% of its pages are open now; else null. */
export async function lastSessionMissing(db: Db, openNormUrls: Set<string>): Promise<Snapshot | null> {
  const latest = newest(await db.snapshots.all());
  if (!latest) return null;
  const pages = new Set(latest.windows.flatMap((w) => w.tabs.map((t) => normalizeUrl(t.url))));
  if (!pages.size) return null;
  let present = 0;
  for (const u of pages) if (openNormUrls.has(u)) present++;
  return present / pages.size < RESTORED_THRESHOLD ? latest : null;
}
export async function listSessions(db: Db): Promise<SessionSummary[]> {
  return (await db.snapshots.all())
    .sort((a, b) => b.takenAt - a.takenAt)
    .map((s) => ({
      id: s.id, takenAt: s.takenAt, windows: s.windows.length, tabs: s.windows.reduce((n, w) => n + w.tabs.length, 0),
    }));
}
/** Copies the session's pages into the stash (same record ids and merge rules as stashing a tab). */
async function stashAll(db: Db, snapshot: Snapshot): Promise<void> {
  const pages = new Map<string, { url: string; title: string }>();
  for (const t of snapshot.windows.flatMap((w) => w.tabs)) {
    if (isWebUrl(t.url) && !pages.has(normalizeUrl(t.url))) pages.set(normalizeUrl(t.url), t);
  }
  const ids = new Map<string, string>();
  for (const normUrl of pages.keys()) ids.set(normUrl, await sha1hex(normUrl));
  const now = Date.now();
  await db.tx(['items', 'queue'], async (s) => {
    for (const [normUrl, t] of pages) {
      const id = ids.get(normUrl)!;
      const item: Item = {
        id, url: t.url, normUrl, title: t.title, domain: domainOf(t.url), state: 'stashed', groupId: null,
        groupSource: 'auto', kind: kindOf(t.url), createdAt: now, lastActiveAt: snapshot.takenAt, updatedAt: now,
        classifiable: true,
      };
      const prev = await s.items.get(id);
      await s.items.put(stashRecord(item, prev, id, now));
      // A page that already has a group keeps it; everything else is classified later.
      if (!prev || prev.groupId === null) await s.queue.add(id);
    }
  });
}
/** One new window with all the session's safe-to-open pages; its first tab is active, the rest inactive. */
async function openAll(snapshot: Snapshot, confirm: boolean): Promise<{ needsConfirm?: number }> {
  const urls = snapshot.windows.flatMap((w) => w.tabs.map((t) => t.url)).filter(isSafeToOpen);
  if (!urls.length) throw new Error('nothing to open');
  if (urls.length > OPEN_ALL_CONFIRM_ABOVE && !confirm) return { needsConfirm: urls.length };
  await chrome.windows.create({ url: urls, focused: true });
  return {};
}
export async function sessionAction(
  db: Db, id: string, action: 'openAll' | 'stashAll' | 'delete', confirm = false,
): Promise<{ needsConfirm?: number }> {
  const snapshot = (await db.snapshots.all()).find((s) => s.id === id);
  if (!snapshot) throw new Error('session not found');
  switch (action) {
    case 'openAll': return openAll(snapshot, confirm);
    case 'stashAll': await stashAll(db, snapshot); return {};
    case 'delete': await db.snapshots.delete(id); return {};
  }
}
export interface StartupCheckOptions {
  intervalMs?: number;
  /** Give up waiting for the browser to finish restoring tabs after this long. */
  maxMs?: number;
  /** The open pages must be unchanged for this many consecutive polls. */
  stableRuns?: number;
}
/**
 * Browser startup: wait until the tabs the browser restores (a few seconds after onStartup, in bursts)
 * stopped changing, compare them with the previous session's snapshot, record the verdict for the
 * dashboard, and only then snapshot the new session. Clears STARTUP_PENDING_KEY when done.
 */
export async function runStartupCheck(db: Db, opts: StartupCheckOptions = {}): Promise<void> {
  const { intervalMs = 2000, maxMs = 20_000, stableRuns = 2 } = opts;
  const started = Date.now();
  let last = '';
  let stable = 0;
  let open: Set<string>;
  for (;;) {
    const tabs = await chrome.tabs.query({});
    open = new Set(tabs.map(tabUrl).filter(isWebUrl).map(normalizeUrl));
    const sig = [...open].sort().join('\n');
    // No web tab yet is never "settled": restoring may not have started, so wait up to maxMs.
    stable = sig === last && open.size > 0 ? stable + 1 : 0;
    last = sig;
    if (stable >= stableRuns || Date.now() - started >= maxMs) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const missing = await lastSessionMissing(db, open);
  await chrome.storage.session.set({ [LAST_SESSION_KEY]: { snapshotId: missing?.id ?? null } });
  await takeSnapshot(db, Date.now());
  await chrome.storage.session.remove(STARTUP_PENDING_KEY);
}
export async function startupPending(): Promise<boolean> {
  try {
    return Boolean((await chrome.storage.session.get(STARTUP_PENDING_KEY))[STARTUP_PENDING_KEY]);
  } catch {
    return false;
  }
}
