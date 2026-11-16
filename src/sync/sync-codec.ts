// Pure stash-sync codec: compact records, chunking under the storage.sync quota, LWW merge, tombstones.
// Everything decoded here comes from storage.sync and is treated as untrusted input.
import { sha1hex } from '../shared/hash';
import type { Item } from '../shared/types';
import { isWebUrl } from '../shared/url';

export { sha1hex };

/** [id = sha1hex(normUrl), normUrl, title ≤ 80, group name ('' = none), stashedAt, updatedAt] */
export type SyncRecord = [id: string, normUrl: string, title: string, group: string, stashedAt: number, updatedAt: number];
export type Tomb = [id: string, deletedAt: number];

export const SYNC_PREFIX = 'v1:';
export const META_KEY = 'v1:meta';
/** Stash share of chrome.storage.sync's 102,400 bytes; synced lessons (lesson-codec) take about 15 KB more. */
export const SYNC_BUDGET = 80_000;
export const CHUNK_MAX = 8_000;
export const MAX_SYNC_TITLE = 80;
export const MAX_NORM_URL = 2048;
export const MAX_GROUP_NAME = 60;
export const TOMB_TTL_MS = 30 * 86_400_000;
/** storage.sync holds at most 512 items; more chunks than this can only be garbage. */
const MAX_CHUNKS = 500;
/** Room kept free inside the budget for the meta key. */
const META_RESERVE = 200;
/**
 * Tombstones are packed first and may use at most this share of the budget; records get the rest
 * (records past the budget stay local only, which is safe: absent is not deleted).
 */
const TOMB_SHARE = 0.75;
const ID_RE = /^[0-9a-f]{40}$/;
const CHUNK_RE = /^v1:(\d+)$/;

const encoder = new TextEncoder();
const utf8 = (s: string) => encoder.encode(s).length;
/** Bytes `s` adds inside a JSON string literal (Chrome measures a value as its JSON stringification). */
const escapedBytes = (s: string) => utf8(JSON.stringify(s)) - 2;

/** Cuts to `max` UTF-16 units without leaving half a surrogate pair. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? out.slice(0, -1) : out;
}

export const chunkKey = (k: number) => `${SYNC_PREFIX}${k}`;
export function chunkIndex(key: string): number | null {
  const m = CHUNK_RE.exec(key);
  return m ? Number(m[1]) : null;
}

export function toRecord(i: Item, groupName: string): SyncRecord {
  return [
    i.id, i.normUrl, truncate(i.title, MAX_SYNC_TITLE), truncate(groupName.trim(), MAX_GROUP_NAME),
    i.stashedAt ?? i.updatedAt, i.updatedAt,
  ];
}

const byIdAsc = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function latestRecords(recs: SyncRecord[]): Map<string, SyncRecord> {
  const out = new Map<string, SyncRecord>();
  for (const r of recs) {
    const prev = out.get(r[0]);
    if (!prev || r[5] > prev[5]) out.set(r[0], r);
  }
  return out;
}

function latestTombs(tombs: Tomb[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, at] of tombs) if (at > (out.get(id) ?? -Infinity)) out.set(id, at);
  return out;
}

/** Greedy packer: entries go into chunks of ≤ chunkMax bytes while the running total stays ≤ limit. */
class Packer {
  private done: string[][] = [];
  private cur: string[] = [];
  private curEsc = 0;
  private total = 0; // bytes of closed chunks

  constructor(private readonly chunkMax: number) {}

  private size(k: number, n: number, esc: number): number {
    // key + `"[` + entries + commas + `]"`
    return utf8(chunkKey(k)) + 4 + esc + Math.max(0, n - 1);
  }

  /** Adds `json` if it fits under `limit` total bytes. 'big' = it can never fit in a chunk. */
  add(json: string, limit: number): 'ok' | 'full' | 'big' {
    const e = escapedBytes(json);
    const k = this.done.length;
    const inCur = this.size(k, this.cur.length + 1, this.curEsc + e);
    if (inCur <= this.chunkMax) {
      if (this.total + inCur > limit) return 'full';
      this.cur.push(json);
      this.curEsc += e;
      return 'ok';
    }
    const alone = this.size(this.cur.length ? k + 1 : k, 1, e);
    if (alone > this.chunkMax) return 'big';
    const closed = this.cur.length ? this.size(k, this.cur.length, this.curEsc) : 0;
    if (this.total + closed + alone > limit) return 'full';
    if (this.cur.length) {
      this.done.push(this.cur);
      this.total += closed;
    }
    this.cur = [json];
    this.curEsc = e;
    return 'ok';
  }


  chunks(): Record<string, string> {
    const all = this.cur.length ? [...this.done, this.cur] : this.done;
    return Object.fromEntries(all.map((c, k) => [chunkKey(k), `[${c.join(',')}]`]));
  }
}

/**
 * Packs tombstones (newest first, at most 75% of the budget, older than 30 days pruned) and then
 * records (newest stashedAt first) into chunks "v1:0".."v1:n". Records past the budget stay local only;
 * `included` is always a newest-first prefix, so freed space promotes the newest local-only items.
 * A record killed by an encoded tombstone (deletedAt >= updatedAt) is left out entirely; one whose
 * tombstone did not fit is encoded, so what is written never depends on tombstones nobody else sees.
 */
export function encodeChunks(
  recs: SyncRecord[], tombs: Tomb[], budget = SYNC_BUDGET, chunkMax = CHUNK_MAX, now = Date.now(),
): { chunks: Record<string, string>; included: string[]; localOnly: string[] } {
  const limit = budget - META_RESERVE;
  const packer = new Packer(chunkMax);
  const liveTombs = [...latestTombs(tombs)]
    .filter(([, at]) => at >= now - TOMB_TTL_MS)
    .sort((a, b) => b[1] - a[1] || byIdAsc(a[0], b[0]));
  const tombLimit = Math.floor(limit * TOMB_SHARE);
  const encodedTombs = new Map<string, number>();
  for (const t of liveTombs) {
    if (packer.add(JSON.stringify(t), tombLimit) !== 'ok') break;
    encodedTombs.set(t[0], t[1]);
  }
  const sorted = [...latestRecords(recs).values()]
    .filter((r) => (encodedTombs.get(r[0]) ?? -Infinity) < r[5])
    .sort((a, b) => b[4] - a[4] || byIdAsc(a[0], b[0]));
  const included: string[] = [];
  const localOnly: string[] = [];
  let full = false;
  for (const r of sorted) {
    const res = full ? 'full' : packer.add(JSON.stringify(r), limit);
    if (res === 'ok') included.push(r[0]);
    else {
      localOnly.push(r[0]);
      if (res === 'full') full = true;
    }
  }
  return { chunks: packer.chunks(), included, localOnly };
}

/**
 * Timestamps are kept raw (re-encoded unchanged). They are not clamped: a clamp relative to each
 * device's clock makes two devices order the same records differently, which never converges.
 */
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function validRecord(e: unknown[]): SyncRecord | null {
  const [id, normUrl, title, group, stashedAt, updatedAt] = e;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (typeof normUrl !== 'string' || normUrl.length > MAX_NORM_URL || !isWebUrl(normUrl)) return null;
  if (typeof title !== 'string' || typeof group !== 'string') return null;
  if (!isTime(stashedAt) || !isTime(updatedAt)) return null;
  const g = group.trim();
  return [id, normUrl, truncate(title, MAX_SYNC_TITLE), g.length > MAX_GROUP_NAME ? '' : g, stashedAt, updatedAt];
}

function validTomb(e: unknown[]): Tomb | null {
  const [id, deletedAt] = e;
  if (typeof id !== 'string' || !ID_RE.test(id) || !isTime(deletedAt)) return null;
  return [id, deletedAt];
}

/** Chunk keys to read: 0..meta.chunks-1 when the meta is valid, else every "v1:<n>" key present. */
function chunkKeys(store: Record<string, unknown>): string[] {
  const meta = Object.hasOwn(store, META_KEY) ? store[META_KEY] : undefined;
  if (typeof meta === 'object' && meta !== null && !Array.isArray(meta)) {
    const n = (meta as { chunks?: unknown }).chunks;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_CHUNKS) {
      return Array.from({ length: n }, (_, k) => chunkKey(k));
    }
  }
  return Object.keys(store).filter((k) => {
    const i = chunkIndex(k);
    return i !== null && i < MAX_CHUNKS;
  });
}

/**
 * Reads records and tombstones from a storage.sync snapshot. Malformed keys, values and entries are
 * ignored, never thrown; every accepted entry is a fresh, validated copy (nothing parsed passes through).
 */
export function decodeChunks(store: Record<string, unknown>): { recs: SyncRecord[]; tombs: Tomb[] } {
  const recs: SyncRecord[] = [];
  const tombs: Tomb[] = [];
  if (typeof store !== 'object' || store === null) return { recs, tombs };
  for (const key of chunkKeys(store)) {
    const raw = Object.hasOwn(store, key) ? store[key] : undefined;
    if (typeof raw !== 'string' || raw.length > CHUNK_MAX * 2) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const e of parsed as unknown[]) {
      if (!Array.isArray(e)) continue;
      if (e.length === 6) {
        const r = validRecord(e);
        if (r) recs.push(r);
      } else if (e.length === 2) {
        const t = validTomb(e);
        if (t) tombs.push(t);
      }
    }
  }
  return { recs: [...latestRecords(recs).values()], tombs: [...latestTombs(tombs)] };
}

/** Drops records whose id is not sha1hex(normUrl) (tampering or corruption). */
export async function verifyIds(recs: SyncRecord[]): Promise<SyncRecord[]> {
  const ok = await Promise.all(recs.map(async (r) => (await sha1hex(r[1])) === r[0]));
  return recs.filter((_, k) => ok[k]);
}

/**
 * Last-writer-wins per record by updatedAt; a tombstone wins when deletedAt ≥ the record's updatedAt.
 * upserts: remote records to apply locally. deletes: local ids to remove. tombs: the union of tombstones.
 * A tombstone a newer record supersedes (a re-stash) stays in the union until its 30-day TTL: LWW lets
 * the record win anyway, and dropping it early would make devices disagree when that record is local only.
 * A local record absent remotely without a tombstone is kept (it is pushed later).
 */
export function merge(
  local: SyncRecord[], localTombs: Tomb[], remote: SyncRecord[], remoteTombs: Tomb[],
): { upserts: SyncRecord[]; deletes: string[]; tombs: Tomb[] } {
  const tombAt = latestTombs([...localTombs, ...remoteTombs]);
  const L = latestRecords(local);
  const R = latestRecords(remote);
  const dead = (id: string, updatedAt: number) => (tombAt.get(id) ?? -Infinity) >= updatedAt;
  const upserts: SyncRecord[] = [];
  for (const [id, r] of R) {
    const l = L.get(id);
    if (l && l[5] >= r[5]) continue;
    if (!dead(id, r[5])) upserts.push(r);
  }
  const deletes: string[] = [];
  for (const [id, l] of L) {
    const newest = Math.max(l[5], R.get(id)?.[5] ?? -Infinity);
    if (dead(id, newest)) deletes.push(id);
  }
  return { upserts, deletes, tombs: [...tombAt] };
}

/**
 * The record set to push after a merge: per id the newer copy, the remote one on a tie (so two devices
 * that agree on updatedAt never rewrite each other's chunks). Tombstoned records are dropped by
 * encodeChunks, against the tombstones it actually encodes.
 */
export function mergedView(local: SyncRecord[], remote: SyncRecord[]): SyncRecord[] {
  const out = latestRecords(local);
  for (const [id, r] of latestRecords(remote)) {
    const l = out.get(id);
    if (!l || r[5] >= l[5]) out.set(id, r);
  }
  return [...out.values()];
}
