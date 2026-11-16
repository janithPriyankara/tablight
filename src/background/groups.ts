import { MAX_EXEMPLARS, OTHER_GROUP_ID, learn } from '../classify/assign';
import type { Group, Item } from '../shared/types';
import { embedText } from '../shared/url';
import { lessonText } from '../sync/lesson-codec';
import { mean, normalize } from '../shared/vec';
import type { Db } from './db';
import { autoGroup, embeddingKey, fingerprintOf, recordDismissed } from './tab-index';
import { nextStamp } from '../shared/stamp';

export const MAX_IDS = 5000;
export const MAX_NAME = 60;
export const USER_COLORS = ['#00959c', '#57914a', '#bb6546', '#7377c6', '#a067ac', '#009775', '#a57710', '#4284c5'];

// ───────────────────────────── validation (shared with the rpc layer) ─────────────────────────────

/** A string array of at most MAX_IDS entries; anything else is rejected. */
export function parseIds(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > MAX_IDS || v.some((x) => typeof x !== 'string')) {
    throw new Error(`ids must be an array of at most ${MAX_IDS} strings`);
  }
  return v as string[];
}

/** A non-empty string of at most MAX_NAME characters after trimming; returns the trimmed name. */
export function parseName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name || name.length > MAX_NAME) throw new Error(`name must be 1-${MAX_NAME} characters`);
  return name;
}

export function parseId(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 200) throw new Error('invalid id');
  return v;
}

// ───────────────────────────── helpers ─────────────────────────────

/** Cached vectors of items (by embedding key); items without one are left out. */
async function vectorsOf(db: Db, items: Item[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  for (const i of items) {
    const v = await db.embeddings.get(await embeddingKey(i));
    if (v) out.set(i.id, Array.from(v));
  }
  return out;
}

interface Taught { vec: number[]; text: string }
/**
 * Teaches `g` each example: its vector becomes an exemplar, and its text (what the model read) a lesson, so
 * the lesson can sync and be learned again by the same model on the user's other devices.
 */
function withExemplars(g: Group, taught: Taught[]): Group {
  const now = Date.now();
  const learned = taught.reduce((acc, t) => learn(acc, t.vec), g);
  if (!taught.length) return learned;
  taught = taught.map((t) => ({ ...t, text: lessonText(t.text) }));
  const texts = new Set(taught.map((t) => t.text));
  const lessons = [...(g.lessons ?? []).filter(([t]) => !texts.has(t)), ...taught.map((t): [string, number] => [t.text, now])]
    .slice(-MAX_EXEMPLARS);
  return { ...learned, lessons };
}

async function mustGroup(db: Db, id: string): Promise<Group> {
  const g = await db.groups.get(id);
  if (!g) throw new Error('unknown group');
  return g;
}

// ───────────────────────────── group CRUD ─────────────────────────────

/**
 * Moves items into a group as a user decision (groupSource 'user') and teaches the group each
 * item's cached vector (newest MAX_EXEMPLARS kept). Unknown ids are ignored.
 */
export async function moveItems(db: Db, ids: string[], groupId: string): Promise<void> {
  const items = (await Promise.all([...new Set(ids)].map((id) => db.items.get(id)))).filter(
    (i): i is Item => i !== undefined,
  );
  const vecs = await vectorsOf(db, items);
  await db.tx(['items', 'groups'], async (s) => {
    const g = await s.groups.get(groupId);
    if (!g) throw new Error('unknown group');
    const taught: Taught[] = [];
    for (const snap of items) {
      const cur = await s.items.get(snap.id);
      if (!cur) continue;
      const already = cur.groupId === groupId && cur.groupSource === 'user';
      await s.items.put({ ...cur, groupId, groupSource: 'user', updatedAt: nextStamp(cur.updatedAt) });
      const v = vecs.get(cur.id);
      if (v && !already) taught.push({ vec: v, text: embedText(cur) });
    }
    if (taught.length) await s.groups.put(withExemplars(g, taught));
  });
}

/** Creates a user group whose exemplars are the cached vectors of `ids`, and moves those items into it. */
/** Group names are unique (ignoring case): sync and tab-group mirroring match groups by name. */
function assertFreeName(all: Group[], name: string, self?: string): void {
  const key = name.toLowerCase();
  if (all.some((g) => g.id !== self && !g.suggested && g.name.toLowerCase() === key)) {
    throw new Error(`A group called “${name}” already exists`);
  }
}
export async function createGroup(db: Db, name: string, ids: string[]): Promise<Group> {
  const clean = parseName(name);
  const items = (await Promise.all([...new Set(ids)].map((id) => db.items.get(id)))).filter(
    (i): i is Item => i !== undefined,
  );
  const vecs = await vectorsOf(db, items);
  return db.tx(['items', 'groups'], async (s) => {
    const all = await s.groups.all();
    assertFreeName(all, clean);
    const base: Group = {
      id: `g-${crypto.randomUUID()}`, name: clean, color: USER_COLORS[all.length % USER_COLORS.length]!,
      icon: '📁', builtIn: false, exemplars: [], centroid: null, createdAt: Date.now(),
    };
    const group = withExemplars(base, items.flatMap((i) => (vecs.has(i.id) ? [{ vec: vecs.get(i.id)!, text: embedText(i) }] : [])));
    await s.groups.put(group);
    for (const snap of items) {
      const cur = await s.items.get(snap.id);
      if (cur) await s.items.put({ ...cur, groupId: group.id, groupSource: 'user', updatedAt: nextStamp(cur.updatedAt) });
    }
    return group;
  });
}

export async function renameGroup(db: Db, id: string, name: string): Promise<void> {
  const clean = parseName(name);
  await db.tx(['groups'], async (s) => {
    const g = await s.groups.get(id);
    if (!g) throw new Error('unknown group');
    assertFreeName(await s.groups.all(), clean, id);
    await s.groups.put({ ...g, name: clean });
  });
}

/** Moves every item and exemplar of `from` into `into` (newest MAX_EXEMPLARS kept), then deletes `from`. */
export async function mergeGroups(db: Db, from: string, into: string): Promise<void> {
  if (from === into) throw new Error('cannot merge a group into itself');
  if (from === OTHER_GROUP_ID) throw new Error('the Other group cannot be merged away');
  await db.tx(['items', 'groups'], async (s) => {
    const src = await s.groups.get(from);
    const dst = await s.groups.get(into);
    if (!src || !dst) throw new Error('unknown group');
    const exemplars = [...dst.exemplars, ...src.exemplars].slice(-MAX_EXEMPLARS);
    const centroid = exemplars.length ? normalize(mean(exemplars)) : (dst.centroid ?? src.centroid);
    const lessons = [...(dst.lessons ?? []), ...(src.lessons ?? [])].sort((a, b) => a[1] - b[1]).slice(-MAX_EXEMPLARS);
    await s.groups.put({ ...dst, exemplars, centroid, ...(lessons.length ? { lessons } : {}), suggested: dst.suggested && src.suggested });
    for (const i of await s.items.all()) {
      // A merge is the user's decision for every item in it: auto-sorting must not pull them back out
      // (the merged-away group no longer exists, so the classifier would drop them to Unsorted).
      if (i.groupId === from) await s.items.put({ ...i, groupId: into, groupSource: 'user', updatedAt: nextStamp(i.updatedAt) });
    }
    await s.groups.delete(from);
  });
}

/** Deletes a group; its items go back to Unsorted for the next classification. 'other' is permanent. */
export async function deleteGroup(db: Db, id: string): Promise<void> {
  if (id === OTHER_GROUP_ID) throw new Error('the Other group cannot be deleted');
  // A deleted group of the user's (or one created automatically) is remembered like a dismissed suggestion,
  // so topic discovery does not put the same tabs straight back into a new group.
  const g = await db.groups.get(id);
  if (g && !g.builtIn) {
    const members = (await db.items.all()).filter((i) => i.groupId === id);
    if (members.length) await recordDismissed(await fingerprintOf(members));
  }
  await db.tx(['items', 'groups', 'queue'], async (s) => {
    if (!(await s.groups.get(id))) throw new Error('unknown group');
    for (const i of await s.items.all()) {
      if (i.groupId !== id) continue;
      await s.items.put({ ...i, groupId: null, groupSource: 'auto', updatedAt: nextStamp(i.updatedAt) });
      if (i.classifiable) await s.queue.add(i.id); // re-sorted into the remaining groups (index.ts kicks it)
    }
    await s.groups.delete(id);
  });
}

// ───────────────────────────── suggestions ─────────────────────────────

/**
 * Accepts a suggested group: it becomes a normal group. Its items are now the user's decision
 * (groupSource 'user') and teach the group, so a later regroup does not undo the acceptance.
 */
export async function acceptSuggestion(db: Db, id: string): Promise<void> {
  const g = await mustGroup(db, id);
  if (!g.suggested) throw new Error('not a suggestion');
  const members = (await db.items.all()).filter((i) => i.groupId === id);
  const vecs = await vectorsOf(db, members);
  await db.tx(['items', 'groups'], async (s) => {
    const cur = await s.groups.get(id);
    if (!cur?.suggested) throw new Error('not a suggestion');
    const taught: Taught[] = [];
    for (const m of members) {
      const i = await s.items.get(m.id);
      if (!i || i.groupId !== id) continue;
      await s.items.put({ ...i, groupSource: 'user', updatedAt: nextStamp(i.updatedAt) });
      const v = vecs.get(i.id);
      if (v) taught.push({ vec: v, text: embedText(i) });
    }
    const { suggested: _s, ...rest } = withExemplars(cur, taught);
    void _s;
    await s.groups.put(rest);
  });
}

/** Dismisses a suggestion: items return to Unsorted and the cluster is remembered so it is not re-suggested. */
export async function dismissSuggestion(db: Db, id: string): Promise<void> {
  const g = await mustGroup(db, id);
  if (!g.suggested) throw new Error('not a suggestion');
  const members = (await db.items.all()).filter((i) => i.groupId === id);
  const fp = await fingerprintOf(members);
  await db.tx(['items', 'groups'], async (s) => {
    const cur = await s.groups.get(id);
    if (!cur?.suggested) throw new Error('not a suggestion');
    for (const m of members) {
      const i = await s.items.get(m.id);
      if (i?.groupId === id) await s.items.put({ ...i, groupId: null, groupSource: 'auto', updatedAt: nextStamp(i.updatedAt) });
    }
    await s.groups.delete(id);
  });
  await recordDismissed(fp);
}

// ───────────────────────────── regroup ─────────────────────────────

interface Move { itemId: string; from: string | null; to: string | null }

/** What the automatic pipeline would now do with each auto item that has a cached vector. */
async function planRegroup(db: Db): Promise<{ moves: Move[]; groups: Group[]; items: Item[] }> {
  const [groups, items] = await Promise.all([db.groups.all(), db.items.all()]);
  const regular = groups.filter((g) => !g.suggested);
  const suggestedIds = new Set(groups.filter((g) => g.suggested).map((g) => g.id));
  const moves: Move[] = [];
  for (const i of items) {
    if (!i.classifiable || i.groupSource !== 'auto') continue;
    if (i.groupId !== null && suggestedIds.has(i.groupId)) continue; // pending suggestions stay as they are
    const v = await db.embeddings.get(await embeddingKey(i));
    if (!v) continue; // no cached vector: unchanged
    const to = autoGroup(i, v, regular);
    if (to !== i.groupId) moves.push({ itemId: i.id, from: i.groupId, to });
  }
  return { moves, groups, items };
}

/** Per-group item counts before/after a regroup; groups whose count would not change are omitted. Writes nothing. */
export async function regroupPreview(db: Db): Promise<{ groupId: string | null; before: number; after: number }[]> {
  const { moves, groups, items } = await planRegroup(db);
  const before = new Map<string | null, number>();
  for (const i of items) before.set(i.groupId, (before.get(i.groupId) ?? 0) + 1);
  const after = new Map(before);
  for (const m of moves) {
    after.set(m.from, (after.get(m.from) ?? 0) - 1);
    after.set(m.to, (after.get(m.to) ?? 0) + 1);
  }
  const ids: (string | null)[] = [null, ...groups.map((g) => g.id)];
  return ids
    .map((groupId) => ({ groupId, before: before.get(groupId) ?? 0, after: after.get(groupId) ?? 0 }))
    .filter((r) => r.before !== r.after);
}

/** Applies the regroup to auto items only; returns how many items changed group. */
export async function regroupApply(db: Db): Promise<number> {
  const { moves } = await planRegroup(db);
  if (!moves.length) return 0;
  return db.tx(['items', 'groups'], async (s) => {
    const known = new Set((await s.groups.all()).map((g) => g.id));
    let n = 0;
    for (const m of moves) {
      const cur = await s.items.get(m.itemId);
      // Skip anything the user or another pass touched since the plan was made.
      if (!cur || cur.groupSource !== 'auto' || cur.groupId !== m.from) continue;
      if (m.to !== null && !known.has(m.to)) continue;
      await s.items.put({ ...cur, groupId: m.to, updatedAt: nextStamp(cur.updatedAt) });
      n++;
    }
    return n;
  });
}

// ───────────────────────────── native tab groups ─────────────────────────────

type ChromeColor = `${chrome.tabGroups.Color}`;
/** Approximate RGB of Chrome's tab-group colors. */
const CHROME_COLORS: [ChromeColor, [number, number, number]][] = [
  ['grey', [0x5f, 0x63, 0x68]], ['blue', [0x1a, 0x73, 0xe8]], ['red', [0xd9, 0x30, 0x25]],
  ['yellow', [0xf9, 0xab, 0x00]], ['green', [0x1e, 0x8e, 0x3e]], ['pink', [0xd0, 0x18, 0x84]],
  ['purple', [0x93, 0x34, 0xe6]], ['cyan', [0x00, 0x7b, 0x83]], ['orange', [0xfa, 0x90, 0x3e]],
];

/** Nearest chrome.tabGroups color to a #rrggbb color (grey for anything unparsable). */
export function nearestChromeColor(hex: string): ChromeColor {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 'grey';
  const n = parseInt(m[1]!, 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  let best: ChromeColor = 'grey';
  let bestD = Infinity;
  for (const [name, c] of CHROME_COLORS) {
    const d = c.reduce((s, x, k) => s + (x - rgb[k]!) ** 2, 0);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

/** chrome.storage.session: native tab group id → our group id, for native groups this extension made. */
export const MIRRORED_KEY = 'mirroredGroups';
async function loadMirrored(): Promise<Map<number, string>> {
  try {
    const raw = (await chrome.storage.session.get(MIRRORED_KEY))[MIRRORED_KEY] as unknown;
    if (raw && typeof raw === 'object') {
      return new Map(Object.entries(raw as Record<string, unknown>)
        .filter((e): e is [string, string] => typeof e[1] === 'string')
        .map(([k, v]) => [Number(k), v]));
    }
  } catch { /* none yet */ }
  return new Map();
}
/**
 * Mirrors our groups as native tab groups in one window. Only when settings.mirrorTabGroups is on and the
 * optional `tabGroups` permission is granted. Open/sleeping, unpinned tabs with a (non-suggested) group are
 * grouped; empty groups are never created. Native groups are tracked by id (storage.session, which lives as
 * long as native group ids do), so two groups with the same name stay apart, and a tab that left our group
 * (moved, Unsorted, group deleted) is taken back out. Native groups the user made are never touched, except
 * that one titled like our group is adopted when we have none for it yet.
 */
export async function mirrorTabGroups(db: Db, windowId: number): Promise<void> {
  if (!(await db.settings.get()).mirrorTabGroups) return;
  if (!(await chrome.permissions.contains({ permissions: ['tabGroups'] }))) return;
  const [groups, items, tabs, allNative, known] = await Promise.all([
    db.groups.all(),
    db.items.all(),
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({}),
    loadMirrored(),
  ]);
  const native = allNative.filter((n) => n.windowId === windowId);
  // Ours: native groups we made that still exist, in any window (only this window's are touched here).
  const live = new Set(allNative.map((n) => n.id));
  const ours = new Map([...known].filter(([nid]) => live.has(nid)));
  const tabById = new Map(tabs.flatMap((t) => (t.id !== undefined ? [[t.id, t] as const] : [])));
  const itemByTab = new Map(items.flatMap((i) => (i.tabId !== undefined && i.state !== 'stashed' ? [[i.tabId, i] as const] : [])));
  const active = new Map(groups.filter((g) => !g.suggested).map((g) => [g.id, g]));
  // 1. Tabs in a native group of ours whose item no longer belongs to that group leave it.
  const leave = tabs.filter((t) => {
    if (t.id === undefined || t.groupId === undefined || t.groupId < 0) return false;
    const owner = ours.get(t.groupId);
    if (owner === undefined) return false;
    return itemByTab.get(t.id)?.groupId !== owner || !active.has(owner);
  }).map((t) => t.id!);
  if (leave.length) await chrome.tabs.ungroup(leave as [number, ...number[]]);
  // 2. Each group's tabs join its native group (ours by id; else a same-titled one nobody owns; else new).
  for (const g of active.values()) {
    const tabIds = items
      .filter((i) => i.groupId === g.id && (i.state === 'open' || i.state === 'sleeping') && i.tabId !== undefined)
      .map((i) => i.tabId!)
      .filter((id) => {
        const t = tabById.get(id);
        return t !== undefined && !t.pinned;
      });
    if (!tabIds.length) continue;
    const mine = native.find((n) => ours.get(n.id) === g.id);
    const existing = mine ?? native.find((n) => n.title === g.name && !ours.has(n.id));
    const todo = existing ? tabIds.filter((id) => tabById.get(id)!.groupId !== existing.id) : tabIds;
    if (existing) ours.set(existing.id, g.id);
    if (!todo.length) continue;
    const ids = todo as [number, ...number[]];
    const nativeId = (await (existing
      ? chrome.tabs.group({ tabIds: ids, groupId: existing.id })
      : chrome.tabs.group({ tabIds: ids, createProperties: { windowId } }))) as unknown as number;
    ours.set(nativeId, g.id);
    await chrome.tabGroups.update(nativeId, { title: g.name, color: nearestChromeColor(g.color) });
  }
  await chrome.storage.session.set({ [MIRRORED_KEY]: Object.fromEntries(ours) }).catch(() => undefined);
}
