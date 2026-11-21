// JSON backup: export the stash (also the bridge between Edge and Chrome) and import it back.
// `parseImport` is pure and treats its input as hostile; `exportJson`/`applyImport` only touch the Db.
import { sha1hex } from '../shared/hash';
import { nextStamp } from '../shared/stamp';
import type { Group, Item, Snapshot } from '../shared/types';
import { isSafeToOpen, isWebUrl, kindOf, normalizeUrl } from '../shared/url';
import { OTHER_GROUP_ID } from '../classify/assign';
import { STARTER_GROUPS } from '../classify/seeds';
import type { Db } from '../background/db';
import { USER_COLORS, parseName } from '../background/groups';
import { forgetRemovedTrained, trainedGroupsForNames } from '../background/grow';
import { restashTime, stashRecord } from '../background/memory';
import { MAX_SNAPSHOTS, fingerprint } from '../background/snapshots';
import { domainOf, withoutPlacedBy } from '../background/tab-index';
import { PRIORITY_GROUP_ID, isPriorityName } from '../shared/priority';
import { priorityForName } from '../background/priority';
export const FORMAT = 'tab-organizer';
export const VERSION = 1;
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
export const MAX_IMPORT_ITEMS = 50_000;
export const MAX_NEW_GROUPS = 200;
const MAX_DEPTH = 64;
const MAX_TITLE = 1_000;
const MAX_URL = 8_192;
const MAX_FILE_SNAPSHOTS = 100;
const MAX_SNAPSHOT_WINDOWS = 100;
const MAX_SNAPSHOT_TABS = 5_000;
const ICONS: ReadonlySet<string> = new Set([...STARTER_GROUPS.map((g) => g.icon), '📁', '✨']);
/** Colors a backup may carry: today's palette and the palette before the redesign (older backups). */
const LEGACY_COLORS = ['#0090ff', '#30a46c', '#f76b15', '#8e4ec6', '#e93d82', '#05a2c2', '#ffb224', '#3e63dd'];
const COLORS: ReadonlySet<string> = new Set([...USER_COLORS, ...LEGACY_COLORS]);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
export interface ImportGroup { name: string; color: string | null; icon: string | null }
export interface ImportItem { url: string; title: string; groupName: string | null; stashedAt: number | null }
/** An open tab in the backup and the group it was in: on import, the same page open here joins that group. */
export interface ImportTab { url: string; title: string; groupName: string | null }
export interface ImportData { groups: ImportGroup[]; items: ImportItem[]; tabs: ImportTab[]; snapshots: Snapshot[] }
export type ParseResult = { ok: true; data: ImportData } | { ok: false; error: string };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function utf8Length(s: string): number {
  return s.length * 3 <= MAX_IMPORT_BYTES ? 0 : new TextEncoder().encode(s).length;
}
/** Bracket nesting deeper than `max` (outside strings)? A linear scan, so no recursion is involved. */
function tooDeep(s: string, max: number): boolean {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (inStr) {
      if (c === 0x5c) i++; // backslash escape
      else if (c === 0x22) inStr = false;
    } else if (c === 0x22) inStr = true;
    else if (c === 0x5b || c === 0x7b) {
      if (++depth > max) return true;
    } else if ((c === 0x5d || c === 0x7d) && depth > 0) depth--;
  }
  return false;
}
const text = (v: string): string => v.replace(CONTROL, '').slice(0, MAX_TITLE);
function safeUrl(v: unknown): string | null {
  return typeof v === 'string' && v.length <= MAX_URL && isWebUrl(v) && isSafeToOpen(v) ? v : null;
}
function readItem(v: unknown, now: number): ImportItem | null {
  if (!isObj(v)) return null;
  const url = safeUrl(v['url']);
  if (url === null) return null;
  const title = v['title'] ?? '';
  const gn = v['groupName'] ?? null;
  if (typeof title !== 'string' || (gn !== null && typeof gn !== 'string')) return null;
  let groupName: string | null = null;
  if (gn !== null) {
    try {
      groupName = parseName(gn);
    } catch { /* invalid name: the item simply has no group */ }
  }
  const at = v['stashedAt'];
  const stashedAt = typeof at === 'number' && Number.isFinite(at) ? Math.min(Math.max(at, 0), now) : null;
  return { url, title: text(title), groupName, stashedAt };
}
function readGroup(v: unknown): ImportGroup | null {
  if (!isObj(v)) return null;
  let name: string;
  try {
    name = parseName(v['name']);
  } catch {
    return null;
  }
  const { color, icon } = v;
  return {
    name,
    color: typeof color === 'string' && COLORS.has(color) ? color : null,
    icon: typeof icon === 'string' && ICONS.has(icon) ? icon : null,
  };
}
function readSnapshot(v: unknown, now: number): Snapshot | null {
  if (!isObj(v) || !Array.isArray(v['windows'])) return null;
  const at = v['takenAt'];
  if (typeof at !== 'number' || !Number.isFinite(at)) return null;
  const windows: Snapshot['windows'] = [];
  let total = 0;
  for (const w of v['windows'].slice(0, MAX_SNAPSHOT_WINDOWS)) {
    if (!isObj(w) || !Array.isArray(w['tabs'])) continue;
    const tabs: { url: string; title: string }[] = [];
    for (const t of w['tabs']) {
      if (total >= MAX_SNAPSHOT_TABS) break;
      if (!isObj(t)) continue;
      const url = safeUrl(t['url']);
      const title = t['title'] ?? '';
      if (url === null || typeof title !== 'string') continue;
      tabs.push({ url, title: text(title) });
      total++;
    }
    if (tabs.length) windows.push({ tabs });
  }
  return windows.length ? { id: '', takenAt: Math.min(Math.max(at, 0), now), windows } : null;
}
export function parseImport(json: string): ParseResult {
  if (typeof json !== 'string') return { ok: false, error: 'not a text file' };
  if (json.length > MAX_IMPORT_BYTES || utf8Length(json) > MAX_IMPORT_BYTES) return { ok: false, error: 'file is too large' };
  if (tooDeep(json, MAX_DEPTH)) return { ok: false, error: 'file is nested too deeply' };
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  if (!isObj(root) || root['format'] !== FORMAT || root['version'] !== VERSION) {
    return { ok: false, error: 'not a Tablight backup' };
  }
  const rawItems = root['items'] ?? [];
  const rawGroups = root['groups'] ?? [];
  const rawSnaps = root['snapshots'] ?? [];
  const rawTabs = root['tabs'] ?? []; // added later: older backups have none
  if (!Array.isArray(rawItems) || !Array.isArray(rawGroups) || !Array.isArray(rawSnaps) || !Array.isArray(rawTabs)) {
    return { ok: false, error: 'malformed backup' };
  }
  if (rawItems.length > MAX_IMPORT_ITEMS || rawTabs.length > MAX_IMPORT_ITEMS) return { ok: false, error: 'too many items' };
  const now = Date.now();
  const items = rawItems.flatMap((v) => readItem(v, now) ?? []);
  const groups = rawGroups.flatMap((v) => readGroup(v) ?? []);
  const snapshots = rawSnaps.slice(0, MAX_FILE_SNAPSHOTS).flatMap((v) => readSnapshot(v, now) ?? []);
  const tabs = rawTabs.flatMap((v) => {
    const it = readItem(v, now);
    return it ? [{ url: it.url, title: it.title, groupName: it.groupName }] : [];
  });
  return { ok: true, data: { groups, items, tabs, snapshots } };
}
export async function exportJson(db: Db): Promise<string> {
  const groups = (await db.groups.all()).filter((g) => !g.suggested && g.id !== OTHER_GROUP_ID);
  const names = new Map(groups.map((g) => [g.id, g.name]));
  const items = (await db.items.byState('stashed')).map((i) => ({
    url: i.url, title: i.title, groupName: (i.groupId !== null && names.get(i.groupId)) || null,
    state: 'stashed' as const, stashedAt: i.stashedAt ?? i.createdAt,
  }));
  // Open and paused web tabs with the group each is in (Unsorted and pending suggestions export no group).
  const tabs = (await db.items.all())
    .filter((i) => i.state !== 'stashed' && i.classifiable)
    .map((i) => ({ url: i.url, title: i.title, groupName: (i.groupId !== null && names.get(i.groupId)) || null }));
  const snapshots = (await db.snapshots.all()).map((s) => ({
    id: s.id, takenAt: s.takenAt, windows: s.windows.map((w) => ({ tabs: w.tabs.map((t) => ({ url: t.url, title: t.title })) })),
  }));
  return JSON.stringify({
    format: FORMAT, version: VERSION, exportedAt: Date.now(),
    groups: groups.map((g) => ({ id: g.id, name: g.name, color: g.color, icon: g.icon })), items, tabs, snapshots,
  }, null, 2);
}
/** Merges by normalized URL; never deletes or downgrades stashed records. A user's own group wins. */
/** `skippedSessions`: new sessions from the file that did not fit (local sessions are never replaced). */
/** `grouped`: open tabs here moved into the group the same page had in the file (tabs you placed stay put). */
export async function applyImport(
  db: Db, data: ImportData, embedFn?: (t: string[]) => Promise<Float32Array[]>,
): Promise<{ added: number; skipped: number; skippedSessions: number; grouped: number }> {
  const now = Date.now();
  const seen = new Set<string>();
  const entries: { it: ImportItem; normUrl: string; id: string }[] = [];
  let skipped = 0;
  for (const it of data.items) {
    const normUrl = normalizeUrl(it.url);
    if (seen.has(normUrl)) {
      skipped++;
      continue;
    }
    seen.add(normUrl);
    entries.push({ it, normUrl, id: await sha1hex(normUrl) }); // hashing must not happen inside the transaction
  }
  const given = new Map(data.groups.map((g) => [g.name.toLowerCase(), g]));
  const wanted = new Map<string, string>();
  const tabGroup = new Map<string, string>(); // normUrl → group name; the first copy in the file wins
  for (const t of data.tabs ?? []) {
    const norm = normalizeUrl(t.url);
    if (t.groupName && !tabGroup.has(norm)) tabGroup.set(norm, t.groupName);
  }
  const names = [...data.groups.map((g) => g.name), ...entries.flatMap((e) => (e.it.groupName ? [e.it.groupName] : [])),
    ...tabGroup.values()];
  for (const n of names) {
    if (!wanted.has(n.toLowerCase())) wanted.set(n.toLowerCase(), n);
  }
  // A name that matches a trained group becomes that group (its id, builtIn). Embedding is not an IndexedDB request.
  const trained = await trainedGroupsForNames(db, [...wanted.values()], embedFn);
  const madeTrained: string[] = [];
  let added = 0;
  let grouped = 0;
  let skippedSessions = 0;
  await db.tx(['items', 'groups', 'queue', 'tombstones', 'snapshots'], async (s) => {
    const existing = (await s.groups.all()).filter((g) => !g.suggested);
    const byName = new Map<string, Group>();
    for (const g of existing) if (!byName.has(g.name.toLowerCase())) byName.set(g.name.toLowerCase(), g);
    const byId = new Set<string>();
    let count = existing.length;
    let created = 0;
    for (const [key, name] of wanted) {
      if (byName.has(key) || created >= MAX_NEW_GROUPS) continue;
      if (isPriorityName(name)) {
        // The backup's Priority tabs go to the built-in Priority group (its name, colour and icon are fixed).
        const p = priorityForName(existing);
        await s.groups.put(p);
        byName.set(key, p);
        created++;
        continue;
      }
      const meta = given.get(key);
      const t = trained.get(key);
      if (t && !existing.some((g) => g.id === t.id) && !byId.has(t.id)) {
        byId.add(t.id);
        created++;
        await s.groups.put({ ...t, createdAt: now });
        byName.set(key, t);
        madeTrained.push(t.id);
        continue;
      }
      const g: Group = {
        id: `g-${crypto.randomUUID()}`, name, color: meta?.color ?? USER_COLORS[count % USER_COLORS.length]!,
        icon: meta?.icon ?? '📁', builtIn: false, exemplars: [], centroid: null, createdAt: now,
      };
      count++;
      created++;
      await s.groups.put(g);
      byName.set(key, g);
    }
    for (const { it, normUrl, id } of entries) {
      const prev = await s.items.get(id);
      const gid = it.groupName ? byName.get(it.groupName.toLowerCase())?.id ?? null : null;
      if (prev && (prev.state !== 'stashed' || gid === null || prev.groupSource === 'user' || prev.groupId === gid)) {
        skipped++;
        continue;
      }
      const base: Item = {
        id, url: it.url, normUrl, title: it.title, domain: domainOf(it.url), state: 'stashed', groupId: gid,
        groupSource: gid === null ? 'auto' : 'user', kind: kindOf(it.url), createdAt: it.stashedAt ?? now,
        lastActiveAt: it.stashedAt ?? now, updatedAt: now, classifiable: true,
      };
      const rec = stashRecord(base, prev, id, await restashTime(s, id, now));
      const stashedAt = Math.min(prev?.stashedAt ?? Infinity, it.stashedAt ?? now);
      await s.items.put({ ...rec, stashedAt });
      if (rec.groupId === null) await s.queue.add(id);
      else await s.queue.remove([id]);
      if (prev) skipped++;
      else added++;
    }
    if (tabGroup.size) {
      for (const cur of await s.items.all()) {
        if (cur.state === 'stashed' || cur.groupSource === 'user') continue; // a group the user chose here wins
        const name = tabGroup.get(cur.normUrl);
        const gid = name ? byName.get(name.toLowerCase())?.id : undefined;
        if (gid === undefined || gid === cur.groupId) continue;
        // Into Priority, the tab remembers where it was, as when the user stars it (taking it out puts it back).
        const before: Item['beforePriority'] = gid === PRIORITY_GROUP_ID
          ? { groupId: cur.groupId, groupSource: cur.groupSource, ...(cur.placedBy !== undefined ? { placedBy: cur.placedBy } : {}) }
          : undefined;
        await s.items.put({
          ...withoutPlacedBy(cur), groupId: gid, groupSource: 'user', updatedAt: nextStamp(cur.updatedAt, now),
          ...(before ? { beforePriority: before } : {}),
        });
        await s.queue.remove([cur.id]);
        grouped++;
      }
    }
    const all = await s.snapshots.all();
    const known = new Set(all.map((x) => fingerprint(x.windows)));
    const fresh: Snapshot[] = [];
    for (const sn of data.snapshots) {
      const fp = fingerprint(sn.windows);
      if (known.has(fp)) continue;
      known.add(fp);
      fresh.push({ ...sn, id: crypto.randomUUID() });
    }
    // Local sessions are never deleted: file sessions (newest first) only fill the free slots.
    const free = Math.max(0, MAX_SNAPSHOTS - all.length);
    const take = fresh.sort((a, b) => b.takenAt - a.takenAt).slice(0, free);
    for (const sn of take) await s.snapshots.put(sn);
    skippedSessions = fresh.length - take.length;
  });
  // The backup asked for these groups: they are no longer "removed" and may grow on the fly again.
  if (madeTrained.length) await forgetRemovedTrained(madeTrained);
  return { added, skipped, skippedSessions, grouped };
}
