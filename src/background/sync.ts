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
import { USER_COLORS } from './groups';
import { domainOf } from './tab-index';

export type { SyncStatus };
export const SYNC_RETRY_ALARM = 'sync-retry';
export const SYNC_STATUS_KEY = 'syncStatus';
export const SYNC_DEBOUNCE_MS = 5_000;
const RETRY_MINUTES = 2;
const ID_RE = /^[0-9a-f]{40}$/;

type Failure = Extract<SyncStatus, { ok: false }>['reason'];

let hooks: { ready?: (db: Db) => Promise<void> } = {};
/** `ready` runs before each sync (index.ts: seed the starter groups first, so names match them). */
export function configureSync(h: { ready?: (db: Db) => Promise<void> }): void {
  hooks = h;
}

/** meta.updatedAt of our own last write: its onChanged echo is ignored. */
let lastWrittenAt = 0;
let chain: Promise<unknown> = Promise.resolve();
/** Sync passes never overlap. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

// ───────────────────────────── status ─────────────────────────────

const DEFAULT_STATUS: SyncStatus = { ok: true, synced: 0, localOnly: 0, lastSyncAt: null };

/** The stored status (validated: storage.local is ours, but never trust a shape blindly). */
export async function readSyncStatus(): Promise<SyncStatus> {
  try {
    const v = (await chrome.storage.local.get(SYNC_STATUS_KEY))[SYNC_STATUS_KEY] as Partial<SyncStatus> | undefined;
    if (typeof v !== 'object' || v === null || typeof v.ok !== 'boolean') return DEFAULT_STATUS;
    return v as SyncStatus;
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
  };
}

/** Applies a merge locally: backup, then deletes (stashed records only), upserts, tombstones. */
async function apply(db: Db, m: ReturnType<typeof merge>): Promise<void> {
  const tombAt = new Map(m.tombs);
  if (m.deletes.length) {
    const stash = await db.items.byState('stashed');
    const doomed = new Set(m.deletes);
    if (stash.some((i) => doomed.has(i.id))) await db.stashBackups.push(stash);
  }
  const known = new Set((await db.groups.all()).map((g) => g.name.toLowerCase()));
  const unknown = [...new Map(
    m.upserts.map((r) => r[3]).filter((n) => n && !known.has(n.toLowerCase())).map((n) => [n.toLowerCase(), n]),
  ).values()];
  const vecs = await centroids(unknown);
  await db.tx(['items', 'groups', 'queue', 'tombstones'], async (s) => {
    const groups = await s.groups.all();
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
      const g = r[3] ? byName.get(r[3].toLowerCase()) : undefined;
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

/** One storage.sync `set` with only the changed chunks plus meta, then removal of stale chunk keys. */
async function write(store: Record<string, unknown>, chunks: Record<string, string>, now: number): Promise<void> {
  const n = Object.keys(chunks).length;
  const changed = Object.fromEntries(Object.entries(chunks).filter(([k, v]) => store[k] !== v));
  const stale = Object.keys(store).filter((k) => (chunkIndex(k) ?? -1) >= n);
  const meta = store[META_KEY] as { chunks?: unknown } | undefined;
  if (!Object.keys(changed).length && !stale.length && meta?.chunks === n) return;
  lastWrittenAt = Math.max(now, lastWrittenAt + 1);
  await chrome.storage.sync.set({ ...changed, [META_KEY]: { chunks: n, updatedAt: lastWrittenAt } });
  if (stale.length) await chrome.storage.sync.remove(stale);
}

/** One full pass: read remote, merge into local, write back what changed. */
async function run(db: Db): Promise<SyncStatus> {
  try {
    if (!(await db.settings.get()).syncEnabled) return await fail('disabled', 'Sync is turned off');
    await hooks.ready?.(db);
    const now = Date.now();
    await db.tombstones.prune(now - TOMB_TTL_MS);
    const store = await chrome.storage.sync.get(null);
    const decoded = decodeChunks(store, now);
    const remote = await verifyIds(decoded.recs);
    const localTombs: Tomb[] = (await db.tombstones.all()).map((t) => [t.id, t.deletedAt]);
    const m = merge(await localRecords(db), localTombs, remote, decoded.tombs);
    await apply(db, m);
    const view = mergedView(await localRecords(db), remote, m.tombs);
    const enc = encodeChunks(view, m.tombs, SYNC_BUDGET, CHUNK_MAX, now);
    await write(store, enc.chunks, now);
    return await save({ ok: true, synced: enc.included.length, localOnly: enc.localOnly.length, lastSyncAt: now });
  } catch (e) {
    const reason = reasonOf(e);
    if (reason === 'rate') {
      await Promise.resolve(chrome.alarms.create(SYNC_RETRY_ALARM, { delayInMinutes: RETRY_MINUTES })).catch(() => undefined);
    }
    return fail(reason, e instanceof Error ? e.message : String(e)).catch(() => ({
      ok: false as const, reason, message: String(e), lastSyncAt: null,
    }));
  }
}

// ───────────────────────────── public API ─────────────────────────────

/** Pushes local stash changes now (merging remote first, so nothing remote is overwritten). Never rejects. */
export function pushSync(db: Db): Promise<SyncStatus> {
  return serial(() => run(db));
}

/** Pulls remote changes (onChanged / startup) and pushes back anything only this device has. Never rejects. */
export function pullSync(db: Db): Promise<SyncStatus> {
  return serial(() => run(db));
}

let timer: ReturnType<typeof setTimeout> | undefined;
/** Debounced push (5 s) after a stash change; the 'sync-retry' alarm and startup cover a killed worker. */
export function scheduleSync(db: Db): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void pushSync(db);
  }, SYNC_DEBOUNCE_MS);
}

/** storage.onChanged: pulls on another device's write to "v1:*"; our own write's echo is ignored. */
export function handleSyncStorageChange(
  db: Db, changes: Record<string, chrome.storage.StorageChange>, areaName: string,
): Promise<SyncStatus> | undefined {
  if (areaName !== 'sync' || !Object.keys(changes).some((k) => k.startsWith(SYNC_PREFIX))) return undefined;
  const meta = changes[META_KEY];
  if (!meta) return undefined; // every device's write carries meta; a lone remove is our stale-key cleanup
  const at = (meta.newValue as { updatedAt?: unknown } | undefined)?.updatedAt;
  if (at !== undefined && at === lastWrittenAt) return undefined;
  return pullSync(db);
}

/** Turning sync off keeps the remote data; turning it on pulls, then pushes. */
export async function setSyncEnabled(db: Db, enabled: boolean): Promise<SyncStatus> {
  await db.settings.set({ syncEnabled: enabled });
  if (!enabled && timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  return pullSync(db);
}

/** A group rename changes the synced name of its stashed items: bump them so the rename wins LWW elsewhere. */
export async function touchStashedInGroup(db: Db, groupId: string): Promise<void> {
  await db.tx(['items'], async (s) => {
    const now = Date.now();
    for (const i of await s.items.byState('stashed')) {
      if (i.groupId === groupId) await s.items.put({ ...i, updatedAt: Math.max(now, i.updatedAt + 1) });
    }
  });
}
