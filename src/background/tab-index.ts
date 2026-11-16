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

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export const BATCH = 32;
export const DEBOUNCE_MS = 500;
/** A continuous event stream still flushes at least this often. */
export const MAX_WAIT_MS = 2_000;
export const KICK_ALARM = 'classify-kick';
export const SUGGEST_MIN_UNSORTED = 4;
export const MAX_SUGGESTED = 5;
/** A new cluster sharing at least this share of its items with a current suggestion is skipped. */
export const SUGGEST_OVERLAP = 0.6;
const SUGGEST_COLORS = ['#7c66dc', '#0d74ce', '#2b9a66', '#cc4e00', '#c2298a'];

/** Embedding cache key: one vector per normalized URL + cleaned title. */
export function embeddingKey(i: Pick<Item, 'normUrl' | 'title' | 'url'>): Promise<string> {
  return sha1hex(`${i.normUrl}\n${cleanTitle(i.title, i.url)}`);
}

function domainOf(url: string): string {
  if (!isWebUrl(url)) return '';
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

// ───────────────────────────── reconcile ─────────────────────────────

/**
 * Makes the open/sleeping items match `tabs` exactly, in one transaction.
 * Existing items are matched by tabId, then (restored sessions with new tab ids) by normUrl+windowId,
 * then (browser restart: window ids changed too) by normUrl alone, most recently active item first.
 * Gone, non-stashed items are deleted. A web item is enqueued when new or when its embedding key
 * (normUrl or cleaned title) changed: auto items are re-classified, user items keep their group.
 */
export async function reconcile(db: Db, tabs: chrome.tabs.Tab[]): Promise<void> {
  const now = Date.now();
  const seen = new Set<number>();
  const live = tabs.filter((t) => t.id !== undefined && t.id >= 0 && !seen.has(t.id) && seen.add(t.id));
  await db.tx(['items', 'queue'], async (s) => {
    const all = await s.items.all();
    const unmatched = new Map(all.filter((i) => i.state !== 'stashed').map((i) => [i.id, i]));
    const byTab = new Map<number, Item>();
    for (const i of unmatched.values()) if (i.tabId !== undefined && !byTab.has(i.tabId)) byTab.set(i.tabId, i);

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
    const liveIds = new Set(live.map((t) => t.id!));
    const orphans = [...unmatched.values()].filter((i) => i.tabId === undefined || !liveIds.has(i.tabId));
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
      const { item, enqueue } = itemFor(t, prev, now);
      if (!prev || changed(prev, item)) await s.items.put(item);
      if (enqueue) await s.queue.add(item.id);
    }
    const gone = [...unmatched.keys()];
    for (const id of gone) await s.items.delete(id);
    if (gone.length) await s.queue.remove(gone);
  });
}

function tabUrl(t: chrome.tabs.Tab): string {
  return t.url || t.pendingUrl || '';
}

function itemFor(t: chrome.tabs.Tab, prev: Item | undefined, now: number): { item: Item; enqueue: boolean } {
  const url = tabUrl(t);
  const normUrl = normalizeUrl(url);
  const title = t.title ?? '';
  const classifiable = isWebUrl(url);
  const lastActiveAt = t.lastAccessed || prev?.lastActiveAt || now;
  const base = {
    url, normUrl, title, domain: domainOf(url), kind: kindOf(url), classifiable, tabId: t.id!, windowId: t.windowId,
    state: t.discarded ? ('sleeping' as const) : ('open' as const), lastActiveAt,
  };
  if (!prev) {
    const item: Item = {
      id: crypto.randomUUID(), ...base, groupId: null, groupSource: 'auto', createdAt: now, updatedAt: now,
    };
    return { item, enqueue: classifiable };
  }
  const navigated = prev.normUrl !== normUrl;
  const retitled = cleanTitle(prev.title, prev.url) !== cleanTitle(title, url);
  const item: Item = { ...prev, ...base, updatedAt: prev.updatedAt };
  // A user's choice is kept; an auto group no longer applies to a non-web page.
  if (!classifiable && item.groupSource === 'auto') item.groupId = null;
  return { item, enqueue: classifiable && (navigated || retitled) };
}

const TRACKED: (keyof Item)[] = [
  'url', 'normUrl', 'title', 'domain', 'kind', 'classifiable', 'tabId', 'windowId', 'state', 'lastActiveAt', 'groupId',
];
function changed(a: Item, b: Item): boolean {
  if (!TRACKED.some((k) => a[k] !== b[k])) return false;
  b.updatedAt = Date.now();
  return true;
}

// ───────────────────────────── debounced tab events ─────────────────────────────

export interface TabIndexConfig {
  db: () => Promise<Db>;
  /** Runs after each reconcile (classification, suggestions, badge). Errors are logged. */
  after?: (db: Db) => Promise<void>;
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
      await reconcile(db, await chrome.tabs.query({}));
      await config.after?.(db);
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

async function drain(db: Db, embedFn: EmbedFn): Promise<number> {
  let total = 0;
  try {
    if ((await db.queue.size()) > 0) await setKick(true);
    do {
      again = false;
      for (;;) {
        const ids = await db.queue.take(BATCH);
        if (!ids.length) break;
        total += await processBatch(db, ids, embedFn);
      }
    } while (again);
    await setKick(false);
    return total;
  } catch (e) {
    await setKick(true);
    throw e;
  }
}

async function processBatch(db: Db, ids: string[], embedFn: EmbedFn): Promise<number> {
  const groups = (await db.groups.all()).filter((g) => !g.suggested);
  const known = new Set(groups.map((g) => g.id));
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

  return db.tx(['items', 'queue', 'embeddings'], async (s) => {
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
        const rule = ruleGroup(cur.url, cur.title);
        groupId = rule !== null && known.has(rule) ? rule : classify(vec, groups, HEAD).groupId;
      }
      await s.items.put({ ...cur, groupId, updatedAt: Date.now() });
      done.push(snap.id);
      written++;
    }
    await s.queue.remove(done);
    return written;
  });
}

async function setKick(on: boolean): Promise<void> {
  try {
    if (on) await chrome.alarms.create(KICK_ALARM, { periodInMinutes: 1 });
    else await chrome.alarms.clear(KICK_ALARM);
  } catch (e) {
    console.error('classify-kick alarm', e);
  }
}

// ───────────────────────────── suggestions ─────────────────────────────

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

  let slots = MAX_SUGGESTED - suggested.length;
  const now = Date.now();
  const created: { group: Group; itemIds: string[] }[] = [];
  for (const c of suggestGroups(input)) {
    if (slots <= 0) break;
    const overlaps = suggested.some(
      (g) => c.itemIds.filter((id) => groupOf.get(id) === g.id).length / c.itemIds.length >= SUGGEST_OVERLAP,
    );
    if (overlaps) continue;
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
          await s.items.put({ ...cur, groupId: group.id, updatedAt: now });
        }
      }
    }
  });
}
