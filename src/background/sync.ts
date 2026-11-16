// Stash sync through the browser account (chrome.storage.sync), using the pure sync-codec.
// Data safety: local items change only through a validated LWW merge; deletes need a tombstone and are
// preceded by a stash backup; a failing storage.sync never touches local data.
import type { Group, Item, SyncStatus } from '../shared/types';
import { isWebUrl, kindOf } from '../shared/url';
import { normalize } from '../shared/vec';
import {
  CHUNK_MAX, META_KEY, SYNC_BUDGET, SYNC_PREFIX, TOMB_TTL_MS, chunkIndex, decodeChunks, encodeChunks, merge,
  mergedView, toRecord, verifyIds, type SyncRecord, type Tomb,
} from '../sync/sync-codec';
import type { Db } from './db';
import { embed } from './embedder';
import { USER_COLORS, parseName } from './groups';
import { domainOf } from './tab-index';
import { nextStamp } from '../shared/stamp';

export type { SyncStatus };
export const SYNC_RETRY_ALARM = 'sync-retry';
/** chrome.storage.local key of the last SyncStatus (read by the UI via readSyncStatus / state). */
export const SYNC_STATUS_KEY = 'syncStatus';
/** chrome.storage.local key: ids that were ever in storage.sync (only those need tombstones). */
export const SYNCED_IDS_KEY = 'syncedIds';
/** chrome.storage.local key: times of our recent pull-triggered storage.sync writes (convergence guard). */
export const SYNC_WRITES_KEY = 'syncWrites';
export const SYNC_DEBOUNCE_MS = 5_000;
export const PULL_DEBOUNCE_MS = 1_000;
/**
 * More than MAX_WRITES writes within WRITE_WINDOW_MS from passes a remote change triggered (pullSync)
 * means the devices keep answering each other: pause. Pushes of the user's own changes never count.
 */
export const MAX_WRITES = 6;
export const WRITE_WINDOW_MS = 10 * 60_000;
const RATE_RETRY_MINUTES = 2;
const PAUSE_RETRY_MINUTES = 15;
const BACKSTOP_MINUTES = 0.5;
/** At most this many groups are created from remote names per pass. */
export const MAX_NEW_GROUPS = 50;
const ID_RE = /^[0-9a-f]{40}$/;

type Failure = Extract<SyncStatus, { ok: false }>['reason'];

interface SyncHooks {
  ready?: (db: Db) => Promise<void>;
  /** Called after a pass applied remote changes (index.ts: kick classification for the queued items). */
  applied?: (db: Db) => void;
}
let hooks: SyncHooks = {};
/** `ready` runs before each sync (index.ts: seed the starter groups first, so names match them). */
export function configureSync(h: SyncHooks): void {
  hooks = h;
}

/** What our own last writes put in storage.sync: their onChanged echo is ignored. */
const lastWritten = new Map<string, string>();
const lastRemoved = new Set<string>();
let lastWrittenAt = 0;
let chain: Promise<unknown> = Promise.resolve();
/** Passes queued or running (wasSynced answers true meanwhile). */
let inFlight = 0;
/** Sync passes never overlap. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  inFlight++;
  const p = chain.then(fn, fn).finally(() => {
    inFlight--;
  });
  chain = p.catch(() => undefined);
  return p;
}

async function localGet(key: string): Promise<unknown> {
  return (await chrome.storage.local.get(key))[key];
}

// ───────────────────────────── status ─────────────────────────────

const DEFAULT_STATUS: SyncStatus = { ok: true, synced: 0, localOnly: 0, lastSyncAt: null };
const REASONS: ReadonlySet<unknown> = new Set<Failure>(['quota', 'disabled', 'rate', 'error']);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** A validated copy of a stored status, or null. */
function parseStatus(v: unknown): SyncStatus | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const at = o.lastSyncAt;
  if (at !== null && !isCount(at)) return null;
  if (o.ok === true && isCount(o.synced) && isCount(o.localOnly)) {
    return { ok: true, synced: o.synced, localOnly: o.localOnly, lastSyncAt: at };
  }
  if (o.ok === false && REASONS.has(o.reason) && typeof o.message === 'string') {
    return { ok: false, reason: o.reason as Failure, message: o.message.slice(0, 500), lastSyncAt: at };
  }
  return null;
}

/** The stored status, or "never synced" when none (or a malformed one) is stored. */
export async function readSyncStatus(): Promise<SyncStatus> {
  try {
    return parseStatus(await localGet(SYNC_STATUS_KEY)) ?? DEFAULT_STATUS;
  } catch {
    return DEFAULT_STATUS;
  }
}

async function save(s: SyncStatus): Promise<SyncStatus> {
  await chrome.storage.local.set({ [SYNC_STATUS_KEY]: s }).catch(() => undefined);
  return s;
}

async function fail(reason: Failure, message: string): Promise<SyncStatus> {
  return save({ ok: false, reason, message, lastSyncAt: (await readSyncStatus()).lastSyncAt });
}

function reasonOf(e: unknown): Failure {
  const msg = e instanceof Error ? e.message : String(e);
  if (/MAX_WRITE_OPERATIONS|MAX_SUSTAINED_WRITE/i.test(msg)) return 'rate';
  if (/QUOTA_BYTES|MAX_ITEMS/i.test(msg)) return 'quota';
  return 'error';
}

async function retryIn(minutes: number): Promise<void> {
  await Promise.resolve(chrome.alarms.create(SYNC_RETRY_ALARM, { delayInMinutes: minutes })).catch(() => undefined);
}

// ───────────────────────────── synced ids ─────────────────────────────

async function syncedIds(): Promise<Set<string>> {
  const v = await localGet(SYNCED_IDS_KEY);
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
}

/**
 * Whether `id` was ever in storage.sync (pushed by us or seen remotely). Only then can another device
 * hold it, so only then does deleting it need a tombstone. When unsure (a pass is queued or running, so
 * it may be pushing the id right now, or storage is failing): true.
 */
export async function wasSynced(id: string): Promise<boolean> {
  if (inFlight > 0) return true;
  try {
    return (await syncedIds()).has(id);
  } catch {
    return true;
  }
}

/** Remote and about-to-be-pushed ids, plus earlier ones still stashed or tombstoned here. */
async function rememberSynced(db: Db, remote: SyncRecord[], included: string[], tombs: Tomb[]): Promise<void> {
  const stashed = new Set((await db.items.byState('stashed')).map((i) => i.id));
  const tombIds = new Set(tombs.map((t) => t[0]));
  const next = new Set([...remote.map((r) => r[0]), ...included, ...tombIds]);
  for (const id of await syncedIds()) if (stashed.has(id)) next.add(id);
  await chrome.storage.local.set({ [SYNCED_IDS_KEY]: [...next] });
}

// ───────────────────────────── local side ─────────────────────────────

async function localRecords(db: Db): Promise<SyncRecord[]> {
  const groups = new Map((await db.groups.all()).map((g) => [g.id, g]));
  return (await db.items.byState('stashed'))
    .filter((i) => ID_RE.test(i.id) && isWebUrl(i.normUrl))
    .map((i) => {
      const g = i.groupId === null ? undefined : groups.get(i.groupId);
      return toRecord(i, g && !g.suggested ? g.name : ''); // unaccepted suggestions stay on this device
    });
}

async function centroids(names: string[]): Promise<(number[] | null)[]> {
  if (!names.length) return [];
  try {
    const vecs = await embed(names);
    return names.map((_, k) => (vecs[k] ? normalize(Array.from(vecs[k])) : null));
  } catch {
    return names.map(() => null); // never block a pull on the model
  }
}

/** The local item for remote record `r` (fields copied one by one; nothing parsed is stored as is). */
function itemFrom(r: SyncRecord, cur: Item | undefined, groupId: string | null, groupSource: Item['groupSource']): Item {
  const [id, normUrl, title, , stashedAt, updatedAt] = r;
  return {
    id, url: cur?.url ?? normUrl, normUrl, title, domain: cur?.domain ?? domainOf(normUrl), state: 'stashed',
    groupId, groupSource, kind: cur?.kind ?? kindOf(normUrl), createdAt: cur?.createdAt ?? stashedAt,
    lastActiveAt: cur?.lastActiveAt ?? stashedAt, stashedAt, updatedAt, classifiable: cur?.classifiable ?? true,
    // The vector key is content-derived: keep it only while the content is unchanged.
    ...(cur?.embKey !== undefined && cur.normUrl === normUrl && cur.title === title ? { embKey: cur.embKey } : {}),
  };
}

const validName = (n: string): string | null => {
  try {
    return parseName(n);
  } catch {
    return null;
  }
};

/** Applies a merge locally: backup, then deletes (stashed records only), upserts, tombstones. */
async function apply(db: Db, m: ReturnType<typeof merge>): Promise<void> {
  const tombAt = new Map(m.tombs);
  if (m.deletes.length) {
    const stash = await db.items.byState('stashed');
    const doomed = new Set(m.deletes);
    if (stash.some((i) => doomed.has(i.id))) await db.stashBackups.push(stash);
  }
  // Suggested groups are not the user's: remote names never match them.
  const known = new Set((await db.groups.all()).filter((g) => !g.suggested).map((g) => g.name.toLowerCase()));
  const unknown = [...new Map(
    m.upserts.map((r) => validName(r[3])).filter((n): n is string => n !== null && !known.has(n.toLowerCase()))
      .map((n) => [n.toLowerCase(), n]),
  ).values()].slice(0, MAX_NEW_GROUPS);
  const vecs = await centroids(unknown);
  await db.tx(['items', 'groups', 'queue', 'tombstones'], async (s) => {
    const groups = (await s.groups.all()).filter((g) => !g.suggested);
    const byName = new Map<string, Group>();
    for (const g of groups) if (!byName.has(g.name.toLowerCase())) byName.set(g.name.toLowerCase(), g);
    let count = groups.length;
    for (const [k, name] of unknown.entries()) {
      if (byName.has(name.toLowerCase())) continue;
      const g: Group = {
        id: `g-${crypto.randomUUID()}`, name, color: USER_COLORS[count++ % USER_COLORS.length]!, icon: '📁',
        builtIn: false, exemplars: [], centroid: vecs[k] ?? null, createdAt: Date.now(),
      };
      await s.groups.put(g);
      byName.set(name.toLowerCase(), g);
    }
    for (const id of m.deletes) {
      const cur = await s.items.get(id);
      // Only stashed records, and only when the tombstone still beats them (no newer local stash).
      if (cur?.state !== 'stashed' || cur.updatedAt > (tombAt.get(id) ?? -Infinity)) continue;
      await s.items.delete(id);
      await s.queue.remove([id]);
    }
    for (const r of m.upserts) {
      const cur = await s.items.get(r[0]);
      if (cur && (cur.state !== 'stashed' || cur.updatedAt >= r[5])) continue;
      const name = validName(r[3]);
      const g = name === null ? undefined : byName.get(name.toLowerCase());
      if (g) {
        await s.items.put(itemFrom(r, cur, g.id, 'user')); // the user's choice on another device
        await s.queue.remove([r[0]]);
      } else if (cur?.groupSource === 'auto' && cur.groupId !== null) {
        await s.items.put(itemFrom(r, cur, cur.groupId, 'auto')); // never silently re-classified
      } else {
        await s.items.put(itemFrom(r, cur, null, 'auto'));
        await s.queue.add(r[0]);
      }
    }
    const have = new Map((await s.tombstones.all()).map((t) => [t.id, t.deletedAt]));
    for (const [id, deletedAt] of m.tombs) {
      if (deletedAt > (have.get(id) ?? -Infinity)) await s.tombstones.put({ id, deletedAt });
    }
  });
}

// ───────────────────────────── remote side ─────────────────────────────

/**
 * Writes only what changed: stale chunk keys are removed first, then one `set` of the changed chunks
 * plus meta. More than MAX_WRITES writes in WRITE_WINDOW_MS → 'paused' (devices keep disagreeing).
 */
async function write(store: Record<string, unknown>, chunks: Record<string, string>, now: number, counted: boolean):
  Promise<'none' | 'wrote' | 'paused'> {
  const n = Object.keys(chunks).length;
  const changed = Object.fromEntries(Object.entries(chunks).filter(([k, v]) => store[k] !== v));
  const stale = Object.keys(store).filter((k) => (chunkIndex(k) ?? -1) >= n);
  const meta = store[META_KEY] as { chunks?: unknown } | undefined;
  if (!Object.keys(changed).length && !stale.length && meta?.chunks === n) return 'none';
  if (counted) {
    const log = await localGet(SYNC_WRITES_KEY);
    const recent = (Array.isArray(log) ? log : [])
      .filter((t): t is number => typeof t === 'number' && t > now - WRITE_WINDOW_MS && t <= now);
    if (recent.length >= MAX_WRITES) return 'paused';
    await chrome.storage.local.set({ [SYNC_WRITES_KEY]: [...recent, now] });
  }
  if (stale.length) {
    for (const k of stale) {
      lastRemoved.add(k);
      lastWritten.delete(k);
    }
    await chrome.storage.sync.remove(stale);
  }
  lastWrittenAt = Math.max(now, lastWrittenAt + 1);
  const payload: Record<string, unknown> = { ...changed, [META_KEY]: { chunks: n, updatedAt: lastWrittenAt } };
  for (const [k, v] of Object.entries(payload)) {
    lastWritten.set(k, JSON.stringify(v));
    lastRemoved.delete(k);
  }
  await chrome.storage.sync.set(payload);
  return 'wrote';
}

/** One full pass: read remote, merge into local, write back what changed. `counted`: pull-triggered. */
async function run(db: Db, counted: boolean): Promise<SyncStatus> {
  try {
    if (!(await db.settings.get()).syncEnabled) return await fail('disabled', 'Sync is turned off');
    await hooks.ready?.(db);
    const now = Date.now();
    await db.tombstones.prune(now - TOMB_TTL_MS);
    const store = await chrome.storage.sync.get(null);
    const decoded = decodeChunks(store);
    const remote = await verifyIds(decoded.recs);
    const localTombs = new Map((await db.tombstones.all()).map((t) => [t.id, t.deletedAt]));
    const m = merge(await localRecords(db), [...localTombs], remote, decoded.tombs);
    await apply(db, m);
    if (m.upserts.length) hooks.applied?.(db);
    const enc = encodeChunks(mergedView(await localRecords(db), remote), m.tombs, SYNC_BUDGET, CHUNK_MAX, now);
    // Before the write: an item opened right after it is pushed must already count as synced.
    await rememberSynced(db, remote, enc.included, m.tombs);
    if ((await write(store, enc.chunks, now, counted)) === 'paused') {
      console.warn(`sync paused: more than ${MAX_WRITES} writes in 10 minutes; retrying in ${PAUSE_RETRY_MINUTES} min`);
      await retryIn(PAUSE_RETRY_MINUTES);
      return await fail('rate', 'sync paused: devices disagree');
    }
    await Promise.resolve(chrome.alarms.clear(SYNC_RETRY_ALARM)).catch(() => undefined);
    return await save({ ok: true, synced: enc.included.length, localOnly: enc.localOnly.length, lastSyncAt: now });
  } catch (e) {
    const reason = reasonOf(e);
    if (reason === 'rate') await retryIn(RATE_RETRY_MINUTES);
    return fail(reason, e instanceof Error ? e.message : String(e)).catch(() => ({
      ok: false as const, reason, message: String(e), lastSyncAt: null,
    }));
  }
}

// ───────────────────────────── public API ─────────────────────────────

/** Pushes local stash changes now (merging remote first, so nothing remote is overwritten). Never rejects. */
export function pushSync(db: Db): Promise<SyncStatus> {
  return serial(() => run(db, false));
}

/** Pulls remote changes (onChanged / startup) and pushes back anything only this device has. Never rejects. */
export function pullSync(db: Db): Promise<SyncStatus> {
  return serial(() => run(db, true));
}

let pushTimer: ReturnType<typeof setTimeout> | undefined;
let pullTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Debounced push (5 s) after a stash change. A 'sync-retry' alarm is set as a backstop (if none is set),
 * so a worker killed before the timer fires still pushes; a successful pass clears it.
 */
export function scheduleSync(db: Db): void {
  if (pushTimer !== undefined) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = undefined;
    void pushSync(db);
  }, SYNC_DEBOUNCE_MS);
  void backstop();
}

/** Sets the backstop alarm unless a sync-retry alarm exists (a rate/pause retry is never moved earlier). */
async function backstop(): Promise<void> {
  try {
    if (!(await chrome.alarms.get(SYNC_RETRY_ALARM))) await chrome.alarms.create(SYNC_RETRY_ALARM, { delayInMinutes: BACKSTOP_MINUTES });
  } catch {
    /* the timer still pushes */
  }
}

/**
 * storage.onChanged: any "v1:*" change from another device schedules a pull (debounced 1 s, so a write
 * delivered in several batches is read once). Changes that only echo our own last write are ignored.
 * Returns whether a pull was scheduled.
 */
export function handleSyncStorageChange(
  db: Db, changes: Record<string, chrome.storage.StorageChange>, areaName: string,
): boolean {
  if (areaName !== 'sync') return false;
  const keys = Object.keys(changes).filter((k) => k.startsWith(SYNC_PREFIX));
  if (!keys.length) return false;
  const own = keys.every((k) => {
    const v = changes[k]!.newValue;
    return v === undefined ? lastRemoved.has(k) : lastWritten.get(k) === JSON.stringify(v);
  });
  if (own) return false;
  if (pullTimer !== undefined) clearTimeout(pullTimer);
  pullTimer = setTimeout(() => {
    pullTimer = undefined;
    void pullSync(db);
  }, PULL_DEBOUNCE_MS);
  return true;
}

/** Turning sync off keeps the remote data; turning it on pulls, then pushes. */
export async function setSyncEnabled(db: Db, enabled: boolean): Promise<SyncStatus> {
  await db.settings.set({ syncEnabled: enabled });
  if (!enabled) {
    for (const t of [pushTimer, pullTimer]) if (t !== undefined) clearTimeout(t);
    pushTimer = pullTimer = undefined;
  }
  return pullSync(db);
}

/** A group rename changes the synced name of its stashed items: bump them so the rename wins LWW elsewhere. */
export async function touchStashedInGroup(db: Db, groupId: string): Promise<void> {
  await db.tx(['items'], async (s) => {
    const now = Date.now();
    for (const i of await s.items.byState('stashed')) {
      if (i.groupId === groupId) await s.items.put({ ...i, updatedAt: nextStamp(i.updatedAt, now) });
    }
  });
}
