import { classify } from '../classify/assign';
import { suggestGroups } from '../classify/cluster';
import { HEAD } from '../classify/head';
import { ruleGroup } from '../classify/rules';
import { sha1hex } from '../shared/hash';
import type { Group, Item } from '../shared/types';
import { cleanTitle, embedText, isWebUrl, kindOf, normalizeUrl } from '../shared/url';
import { mean, normalize } from '../shared/vec';
import type { Db } from './db';
import { embed } from './embedder';
import { nextStamp } from '../shared/stamp';

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export const BATCH = 32;
export const DEBOUNCE_MS = 500;
/** A continuous event stream still flushes at least this often. */
export const MAX_WAIT_MS = 2_000;
export const KICK_ALARM = 'classify-kick';
/** Alarm period while the queue keeps failing as a whole (the embedder itself is down). */
export const BACKOFF_MINUTES = 15;
/** After this many failed attempts a batch is retried one item at a time. */
export const MAX_ATTEMPTS = 3;
/** Hard cap: an item failing this often is written Unsorted and dropped, whatever the cause. */
export const GIVE_UP_ATTEMPTS = 10;
/** A title-only change re-embeds an item at most this often (live titles: timers, tickers, chats). */
export const RETITLE_INTERVAL_MS = 5 * 60_000;
export const SUGGEST_MIN_UNSORTED = 4;
export const MAX_SUGGESTED = 5;
/** A new cluster sharing at least this share of its items with a current suggestion is skipped. */
export const SUGGEST_OVERLAP = 0.6;
const SUGGEST_COLORS = ['#7c66dc', '#0d74ce', '#2b9a66', '#cc4e00', '#c2298a'];
/** chrome.storage.session key: present while the browser session that the index's tab ids belong to lasts. */
export const SESSION_KEY = 'tabIndexSession';

/** Embedding cache key: one vector per normalized URL + cleaned title. */
export function embeddingKey(i: Pick<Item, 'normUrl' | 'title' | 'url'>): Promise<string> {
  return sha1hex(`${i.normUrl}\n${cleanTitle(i.title, i.url)}`);
}

export function domainOf(url: string): string {
  if (!isWebUrl(url)) return '';
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

// ───────────────────────────── reconcile ─────────────────────────────

export interface ReconcileResult {
  created: number;
  deleted: number;
  enqueued: number;
  /** Tabs whose URL changed or that are new: their per-tab badge must be re-set. */
  navigatedTabIds: number[];
}

/** itemId → when a title-only change last re-enqueued it (memory: lost with the worker, which is fine). */
const retitledAt = new Map<string, number>();

/**
 * Makes the open/sleeping items match `tabs` exactly, in one transaction.
 * Matching: by tabId (only within the same browser session: tab ids restart from small numbers after a
 * restart, so `newSession` skips it), then by normUrl+windowId, then by normUrl alone with the most
 * recently active item first. Gone, non-stashed items are deleted.
 * A web item is enqueued when new, when its URL changed, or when its title changed meaningfully
 * (ignoring digit-only churn), at most once per RETITLE_INTERVAL_MS after its first real title.
 * Auto items are then re-classified; user items keep their group.
 */
export async function reconcile(
  db: Db,
  tabs: chrome.tabs.Tab[],
  opts: { newSession?: boolean } = {},
): Promise<ReconcileResult> {
  const now = Date.now();
  const seen = new Set<number>();
  const live = tabs.filter((t) => t.id !== undefined && t.id >= 0 && !seen.has(t.id) && seen.add(t.id));
  const result: ReconcileResult = { created: 0, deleted: 0, enqueued: 0, navigatedTabIds: [] };
  await db.tx(['items', 'queue'], async (s) => {
    const all = await s.items.all();
    const unmatched = new Map(all.filter((i) => i.state !== 'stashed').map((i) => [i.id, i]));
    const byTab = new Map<number, Item>();
    if (!opts.newSession) {
      for (const i of unmatched.values()) if (i.tabId !== undefined && !byTab.has(i.tabId)) byTab.set(i.tabId, i);
    }
    const pairs: [chrome.tabs.Tab, Item | undefined][] = [];
    const pending: chrome.tabs.Tab[] = [];
    for (const t of live) {
      const i = byTab.get(t.id!);
      if (i) {
        unmatched.delete(i.id);
        pairs.push([t, i]);
      } else pending.push(t);
    }
    // Restored sessions: tab ids changed, the window and URL did not.
    const matchedIds = new Set(pairs.map(([t]) => t.id!));
    const orphans = [...unmatched.values()].filter(
      (i) => opts.newSession || i.tabId === undefined || !matchedIds.has(i.tabId),
    );
    const take = (k: number) => {
      const i = orphans.splice(k, 1)[0]!;
      unmatched.delete(i.id);
      return i;
    };
    const rest: chrome.tabs.Tab[] = [];
    for (const t of pending) {
      const norm = normalizeUrl(tabUrl(t));
      const k = orphans.findIndex((i) => i.normUrl === norm && i.windowId === t.windowId);
      if (k >= 0) pairs.push([t, take(k)]);
      else rest.push(t);
    }
    // Browser restart: window ids changed too. Match by URL alone, most recently active item first.
    orphans.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    for (const t of rest) {
      const norm = normalizeUrl(tabUrl(t));
      const k = orphans.findIndex((i) => i.normUrl === norm);
      pairs.push([t, k >= 0 ? take(k) : undefined]);
    }

    for (const [t, prev] of pairs) {
      const { item, enqueue, navigated } = itemFor(t, prev, now);
      if (!prev) result.created++;
      if (navigated) result.navigatedTabIds.push(item.tabId!);
      if (!prev || changed(prev, item)) await s.items.put(item);
      if (enqueue) {
        await s.queue.add(item.id);
        result.enqueued++;
      }
    }
    const gone = [...unmatched.keys()];
    for (const id of gone) {
      await s.items.delete(id);
      retitledAt.delete(id);
    }
    if (gone.length) await s.queue.remove(gone);
    result.deleted = gone.length;
  });
  return result;
}

function tabUrl(t: chrome.tabs.Tab): string {
  return t.url || t.pendingUrl || '';
}

/** A title with no words of its own (empty or the URL): the page hasn't loaded its real title yet. */
function isPlaceholderTitle(title: string, url: string): boolean {
  const t = title.trim();
  return !t || t === url.trim() || /^https?:\/\/\S+$/i.test(t);
}

/** Digit-only changes (clocks, counters, prices) don't change what a page is about. */
const titleGist = (title: string, url: string) => cleanTitle(title, url).replace(/\p{N}+/gu, '#');

function itemFor(
  t: chrome.tabs.Tab,
  prev: Item | undefined,
  now: number,
): { item: Item; enqueue: boolean; navigated: boolean } {
  const url = tabUrl(t);
  const normUrl = normalizeUrl(url);
  const title = t.title ?? '';
  const classifiable = isWebUrl(url);
  // tabs.Tab.lastAccessed is Chrome 121+; onActivated (touchTab) keeps lastActiveAt current too.
  const lastActiveAt = Math.max(t.lastAccessed ?? 0, prev?.lastActiveAt ?? 0) || now;
  const base = {
    url, normUrl, title, domain: domainOf(url), kind: kindOf(url), classifiable, tabId: t.id!, windowId: t.windowId,
    state: t.discarded ? ('sleeping' as const) : ('open' as const), lastActiveAt,
  };
  if (!prev) {
    const item: Item = {
      id: crypto.randomUUID(), ...base, groupId: null, groupSource: 'auto', createdAt: now, updatedAt: now,
    };
    return { item, enqueue: classifiable, navigated: true };
  }
  const navigated = prev.normUrl !== normUrl;
  const item: Item = { ...prev, ...base, updatedAt: prev.updatedAt };
  // A user's choice is kept; an auto group no longer applies to a non-web page.
  if (!classifiable && item.groupSource === 'auto') item.groupId = null;
  let enqueue = classifiable && navigated;
  if (navigated) retitledAt.delete(item.id);
  else if (classifiable && titleGist(prev.title, prev.url) !== titleGist(title, url)) {
    // The first real title (replacing a placeholder) always counts; later changes are rate-limited.
    const last = retitledAt.get(item.id);
    if (isPlaceholderTitle(prev.title, prev.url) || last === undefined || now - last >= RETITLE_INTERVAL_MS) {
      enqueue = true;
      if (!isPlaceholderTitle(prev.title, prev.url)) retitledAt.set(item.id, now);
    }
  }
  return { item, enqueue, navigated };
}

const TRACKED: (keyof Item)[] = [
  'url', 'normUrl', 'title', 'domain', 'kind', 'classifiable', 'tabId', 'windowId', 'state', 'lastActiveAt', 'groupId',
];
function changed(a: Item, b: Item): boolean {
  if (!TRACKED.some((k) => a[k] !== b[k])) return false;
  b.updatedAt = nextStamp(a.updatedAt);
  return true;
}

/** Records that a tab was just activated (light path: no reconcile). */
export async function touchTab(db: Db, tabId: number, now = Date.now()): Promise<void> {
  await db.tx(['items'], async (s) => {
    const i = await s.items.byTabId(tabId);
    if (i && i.state !== 'stashed' && i.lastActiveAt < now) await s.items.put({ ...i, lastActiveAt: now });
  });
}

/** Deletes cached embeddings no item's current content uses any more. Returns how many went. */
export async function sweepEmbeddings(db: Db): Promise<number> {
  const items = await db.items.all();
  const used = new Set(await Promise.all(items.filter((i) => i.classifiable).map(embeddingKey)));
  for (const i of items) if (i.embKey !== undefined) used.add(i.embKey); // search reads vectors by embKey
  const stale = (await db.embeddings.keys()).filter((k) => !used.has(k));
  if (!stale.length) return 0;
  await db.tx(['embeddings'], async (s) => {
    for (const k of stale) await s.embeddings.delete(k);
  });
  return stale.length;
}

/** At most this many items are examined per backfill pass. */
export const BACKFILL_LIMIT = 200;
/** Items given up on are not backfilled (re-queued) for this long. */
export const BACKFILL_RETRY_MS = 24 * 3_600_000;
/**
 * Safety net for items that have no `embKey` (created by stash/import/sync paths that build fresh
 * records): sets it when the cached vector exists, else queues the item so classification embeds it.
 * Bounded per call; returns how many items were queued.
 */
export async function backfillEmbKeys(db: Db, limit = BACKFILL_LIMIT, now = Date.now()): Promise<number> {
  // Given-up items are filtered before the slice so they can't starve the others.
  const todo = (await db.items.all())
    .filter((i) => i.classifiable && i.embKey === undefined && !(i.embGaveUpAt !== undefined && now - i.embGaveUpAt < BACKFILL_RETRY_MS))
    .slice(0, limit);
  if (!todo.length) return 0;
  const keys = await Promise.all(todo.map(embeddingKey));
  const have = await db.embeddings.getMany([...new Set(keys)]);
  let queued = 0;
  await db.tx(['items', 'queue'], async (s) => {
    for (const [k, snap] of todo.entries()) {
      const cur = await s.items.get(snap.id);
      if (!cur || !cur.classifiable || cur.embKey !== undefined) continue;
      if (cur.normUrl !== snap.normUrl || cur.title !== snap.title) continue;
      if (have.has(keys[k]!)) await s.items.put({ ...cur, embKey: keys[k]! }); // local-only field: no updatedAt bump
      else {
        await s.queue.add(cur.id);
        queued++;
      }
    }
  });
  return queued;
}
// ───────────────────────────── debounced tab events ─────────────────────────────

export interface TabIndexConfig {
  db: () => Promise<Db>;
  /** Runs after each reconcile (classification, suggestions, badge). Errors are logged. */
  after?: (db: Db, result: ReconcileResult) => Promise<void>;
}
let config: TabIndexConfig | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let firstEventAt = 0;
let chain: Promise<void> = Promise.resolve();

export function configureTabIndex(c: TabIndexConfig): void {
  config = c;
}

/** Debounced (500 ms, max 2 s) → tabs.query({}) → reconcile → `after` hook. Safe to call per event. */
export function onTabEvent(): void {
  const now = Date.now();
  if (!timer) firstEventAt = now;
  else clearTimeout(timer);
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstEventAt + MAX_WAIT_MS - now));
  timer = setTimeout(() => {
    timer = undefined;
    void flushTabEvents();
  }, wait);
}

/**
 * True when the stored tab ids may belong to an earlier browser session. chrome.storage.session is
 * cleared when the browser restarts (and on extension reload), so a missing marker means "new session".
 */
async function sessionIsNew(): Promise<boolean> {
  try {
    return !(await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
  } catch {
    return false;
  }
}

/** Reconciles now (cancels a pending debounce). Runs are serialized. Never rejects. */
export function flushTabEvents(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  const run = chain.then(async () => {
    if (!config) return;
    try {
      const db = await config.db();
      const newSession = await sessionIsNew();
      const result = await reconcile(db, await chrome.tabs.query({}), { newSession });
      if (newSession) await chrome.storage.session.set({ [SESSION_KEY]: Date.now() }).catch(() => undefined);
      await config.after?.(db, result);
    } catch (e) {
      console.error('tab index flush failed', e);
    }
  });
  chain = run;
  return run;
}

/** Resolves once no debounce is pending and every flush has finished. */
export async function whenTabIndexIdle(): Promise<void> {
  for (;;) {
    const c = chain;
    await c;
    if (!timer && c === chain) return;
    if (timer) await new Promise((r) => setTimeout(r, DEBOUNCE_MS));
  }
}

// ───────────────────────────── classification queue ─────────────────────────────

let running: Promise<number> | undefined;
let again = false;

/**
 * Classifies queued items 32 at a time until the queue is empty and returns how many were written.
 * Pipeline: groupSource 'user' keeps its group > ruleGroup > classify (trained head) > Unsorted.
 * An entry leaves the queue only in the same transaction that writes its item, so a killed worker
 * resumes where it stopped. While work remains the `classify-kick` alarm stays set to wake us.
 * A batch that failed MAX_ATTEMPTS times is retried item by item: an item that fails while others
 * succeed is written Unsorted and dropped; if all fail the embedder is down and the alarm backs off.
 * Concurrent calls share the running pass (which then drains once more).
 */
export function processQueue(db: Db, embedFn: EmbedFn = embed): Promise<number> {
  if (running) {
    again = true;
    return running;
  }
  running = drain(db, embedFn).finally(() => {
    running = undefined;
  });
  return running;
}

class EmbedderDown extends Error {}

async function drain(db: Db, embedFn: EmbedFn): Promise<number> {
  let total = 0;
  try {
    if ((await db.queue.size()) > 0) await setKick(1, true);
    do {
      again = false;
      for (;;) {
        const ids = await db.queue.take(BATCH);
        if (!ids.length) break;
        total += await processWithRetry(db, ids, embedFn);
      }
    } while (again);
    await setKick(0);
    return total;
  } catch (e) {
    again = false;
    await setKick(e instanceof EmbedderDown ? BACKOFF_MINUTES : 1);
    throw e instanceof EmbedderDown && e.cause instanceof Error ? e.cause : e;
  }
}

async function processWithRetry(db: Db, ids: string[], embedFn: EmbedFn): Promise<number> {
  try {
    return await processBatch(db, ids, embedFn);
  } catch (e) {
    const attempts = Math.max(0, ...(await db.queue.fail(ids)));
    if (attempts < MAX_ATTEMPTS) throw e;
    // Isolate the poison item(s).
    let written = 0;
    const failed: string[] = [];
    let lastError: unknown = e;
    for (const id of ids) {
      try {
        written += await processBatch(db, [id], embedFn);
      } catch (err) {
        failed.push(id);
        lastError = err;
      }
    }
    if (!failed.length) return written;
    const counts = await db.queue.fail(failed);
    const giveUp = failed.filter((_, k) => written > 0 || counts[k]! >= GIVE_UP_ATTEMPTS);
    if (giveUp.length) written += await writeUnsorted(db, giveUp);
    if (giveUp.length < failed.length) throw new EmbedderDown('embedder unavailable', { cause: lastError });
    return written;
  }
}

/** Gives up on items: auto items become Unsorted, user items keep their group; they leave the queue. */
async function writeUnsorted(db: Db, ids: string[]): Promise<number> {
  const now = Date.now();
  return db.tx(['items', 'queue'], async (s) => {
    let n = 0;
    for (const id of ids) {
      const cur = await s.items.get(id);
      if (!cur) continue;
      if (cur.groupSource === 'auto') {
        await s.items.put({ ...cur, groupId: null, embGaveUpAt: now, updatedAt: nextStamp(cur.updatedAt) });
        n++;
      } else await s.items.put({ ...cur, embGaveUpAt: now }); // local-only stamp: no updatedAt bump
    }
    await s.queue.remove(ids);
    return n;
  });
}

/**
 * The automatic pipeline for one embedded item: ruleGroup (only when that group exists) > classify
 * (trained head + user-taught exemplars) > null. `groups` must exclude suggested groups.
 */
export function autoGroup(item: Pick<Item, 'url' | 'title'>, vec: ArrayLike<number>, groups: Group[]): string | null {
  const rule = ruleGroup(item.url, item.title);
  if (rule !== null && groups.some((g) => g.id === rule)) return rule;
  return classify(vec, groups, HEAD).groupId;
}
async function processBatch(db: Db, ids: string[], embedFn: EmbedFn): Promise<number> {
  const read = await Promise.all(ids.map((id) => db.items.get(id)));
  const drop = ids.filter((id, k) => !read[k]?.classifiable);
  const todo = read.filter((i): i is Item => !!i?.classifiable);

  // Embed (cached): one vector per distinct key, only cache misses go to the model.
  const keys = await Promise.all(todo.map(embeddingKey));
  const vecs = new Map<string, Float32Array>();
  const missing = new Map<string, string>();
  for (const [k, key] of keys.entries()) {
    if (vecs.has(key) || missing.has(key)) continue;
    const hit = await db.embeddings.get(key);
    if (hit) vecs.set(key, hit);
    else missing.set(key, embedText(todo[k]!));
  }
  const fresh = new Map<string, Float32Array>();
  if (missing.size) {
    const out = await embedFn([...missing.values()]);
    if (out.length !== missing.size) throw new Error('embedder returned the wrong number of vectors');
    [...missing.keys()].forEach((key, k) => fresh.set(key, out[k]!));
  }

  return db.tx(['items', 'queue', 'embeddings', 'groups'], async (s) => {
    // Read the groups here so a group deleted meanwhile is never assigned.
    const groups = (await s.groups.all()).filter((g) => !g.suggested);
    for (const [key, v] of fresh) {
      await s.embeddings.put(key, v);
      vecs.set(key, v);
    }
    let written = 0;
    const done = [...drop];
    for (const [k, snap] of todo.entries()) {
      const cur = await s.items.get(snap.id);
      if (!cur || !cur.classifiable) {
        done.push(snap.id);
        continue;
      }
      // Changed while we were embedding (navigation): leave it queued for the next pass.
      if (cur.normUrl !== snap.normUrl || cleanTitle(cur.title, cur.url) !== cleanTitle(snap.title, snap.url)) continue;
      const vec = vecs.get(keys[k]!)!;
      let groupId = cur.groupId;
      if (cur.groupSource !== 'user') {
        groupId = autoGroup(cur, vec, groups);
      }
      const { embGaveUpAt: _cleared, ...rest } = cur; // a success lifts any earlier give-up stamp
      void _cleared;
      await s.items.put({ ...rest, groupId, embKey: keys[k]!, updatedAt: nextStamp(cur.updatedAt) });
      done.push(snap.id);
      written++;
    }
    await s.queue.remove(done);
    return written;
  });
}

/**
 * periodInMinutes > 0 sets the classify-kick alarm (unless it already has that period, or any alarm
 * exists and `keep` is set, so a backed-off alarm isn't reset); 0 clears it.
 */
async function setKick(periodInMinutes: number, keep = false): Promise<void> {
  try {
    if (periodInMinutes <= 0) {
      await chrome.alarms.clear(KICK_ALARM);
      return;
    }
    const cur = await chrome.alarms.get(KICK_ALARM);
    if (keep && cur) return;
    if (cur?.periodInMinutes !== periodInMinutes) await chrome.alarms.create(KICK_ALARM, { periodInMinutes });
  } catch (e) {
    console.error('classify-kick alarm', e);
  }
}

// ───────────────────────────── suggestions ─────────────────────────────
const DISMISSED_KEY = 'dismissedSuggestions';
/** At most this many dismissed suggestions are remembered (newest kept). */
export const MAX_DISMISSED = 200;
/** Privacy-light fingerprint of one item: a short hash of its normalized URL. */
async function urlFingerprint(normUrl: string): Promise<string> {
  return (await sha1hex(normUrl)).slice(0, 12);
}
/** Fingerprints (sorted URL hashes) of the items of a suggestion, for dismissal memory. */
export async function fingerprintOf(items: Pick<Item, 'normUrl'>[]): Promise<string[]> {
  return [...new Set(await Promise.all(items.map((i) => urlFingerprint(i.normUrl))))].sort();
}
/** Dismissed suggestions, oldest first. Storage trouble reads as "none dismissed". */
export async function loadDismissed(): Promise<string[][]> {
  try {
    const got = await chrome.storage.local.get(DISMISSED_KEY);
    const v = got[DISMISSED_KEY];
    return Array.isArray(v) ? (v as unknown[]).filter((x): x is string[] => Array.isArray(x)) : [];
  } catch {
    return [];
  }
}
/** Appends a dismissed fingerprint, keeping the newest MAX_DISMISSED. */
export async function recordDismissed(fp: string[]): Promise<void> {
  if (!fp.length) return;
  const next = [...(await loadDismissed()), fp].slice(-MAX_DISMISSED);
  await chrome.storage.local.set({ [DISMISSED_KEY]: next });
}

/**
 * When Unsorted has ≥ 4 web items, clusters Unsorted (plus the members of current suggestions,
 * so a topic already suggested is recognised) and stores each new cluster as a Group{suggested:true}
 * whose items move into it (groupSource stays 'auto': accepting flips `suggested`, dismissing deletes it).
 * Clusters overlapping a current suggestion by ≥ 60% are skipped; at most 5 suggestions exist at once.
 */
export async function maybeSuggest(db: Db): Promise<void> {
  const groups = await db.groups.all();
  const suggested = groups.filter((g) => g.suggested);
  if (suggested.length >= MAX_SUGGESTED) return;
  const suggestedIds = new Set(suggested.map((g) => g.id));
  const items = (await db.items.all()).filter((i) => i.classifiable);
  const unsorted = items.filter((i) => i.groupId === null);
  if (unsorted.length < SUGGEST_MIN_UNSORTED) return;

  const pool = items
    .filter((i) => i.groupId === null || suggestedIds.has(i.groupId))
    .sort((a, b) => a.createdAt - b.createdAt);
  const input: { id: string; title: string; domain: string; vec: number[] }[] = [];
  for (const i of pool) {
    const v = await db.embeddings.get(await embeddingKey(i));
    if (v) input.push({ id: i.id, title: cleanTitle(i.title, i.url), domain: i.domain, vec: Array.from(v) });
  }
  const vecOf = new Map(input.map((x) => [x.id, x.vec]));
  const groupOf = new Map(pool.map((i) => [i.id, i.groupId]));

  const dismissed = (await loadDismissed()).map((d) => new Set(d));
  const normOf = new Map(pool.map((i) => [i.id, i.normUrl]));
  let slots = MAX_SUGGESTED - suggested.length;
  const now = Date.now();
  const created: { group: Group; itemIds: string[] }[] = [];
  for (const c of suggestGroups(input)) {
    if (slots <= 0) break;
    const overlaps = suggested.some(
      (g) => c.itemIds.filter((id) => groupOf.get(id) === g.id).length / c.itemIds.length >= SUGGEST_OVERLAP,
    );
    if (overlaps) continue;
    if (dismissed.length) {
      const fp = new Set(await fingerprintOf(c.itemIds.map((id) => ({ normUrl: normOf.get(id)! }))));
      if (dismissed.some((d) => [...fp].filter((h) => d.has(h)).length / fp.size >= SUGGEST_OVERLAP)) continue;
    }
    const itemIds = c.itemIds.filter((id) => groupOf.get(id) === null);
    if (!itemIds.length) continue;
    const id = `suggested-${crypto.randomUUID()}`;
    const color = SUGGEST_COLORS[(suggested.length + created.length) % SUGGEST_COLORS.length]!;
    created.push({
      group: {
        id, name: c.name, color, icon: '✨', builtIn: false, exemplars: [], suggested: true, createdAt: now,
        centroid: normalize(mean(c.itemIds.map((x) => vecOf.get(x)!))),
      },
      itemIds,
    });
    slots--;
  }
  if (!created.length) return;
  await db.tx(['items', 'groups'], async (s) => {
    for (const { group, itemIds } of created) {
      await s.groups.put(group);
      for (const id of itemIds) {
        const cur = await s.items.get(id);
        // Only still-Unsorted auto items move; anything the user or the queue touched meanwhile stays.
        if (cur && cur.groupId === null && cur.groupSource === 'auto') {
          await s.items.put({ ...cur, groupId: group.id, updatedAt: nextStamp(cur.updatedAt, now) });
        }
      }
    }
  });
}
