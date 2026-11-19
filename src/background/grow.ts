// Groups that appear on the fly: a trained on-demand group is created once enough auto-placed tabs want it.
import { TRAINED_IDS, buildTrainedGroup } from '../classify/assign';
import { VIDEOS_GROUP_ID } from '../classify/pick';
import { STARTER_GROUPS, trainedIdForName } from '../classify/seeds';
import { nextStamp } from '../shared/stamp';
import type { Group, Item } from '../shared/types';
import type { Db } from './db';

/** A trained group is created on the fly once this many auto-placed tabs want it (two alike tabs are a coincidence). */
export const GROW_MIN = 3;
/** chrome.storage.local: ids of trained on-demand groups the user deleted (string[]); never re-created on the fly. */
export const REMOVED_TRAINED_KEY = 'removedTrainedGroups';

/** Trained group ids the user removed. Storage trouble reads as "none removed". */
export async function loadRemovedTrained(): Promise<string[]> {
  try {
    const v = (await chrome.storage.local.get(REMOVED_TRAINED_KEY))[REMOVED_TRAINED_KEY];
    return Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
/** Remembers that the user removed a trained on-demand group (other ids are ignored). */
export async function recordRemovedTrained(id: string): Promise<void> {
  if (!TRAINED_IDS.has(id)) return;
  const cur = await loadRemovedTrained();
  if (cur.includes(id)) return;
  await chrome.storage.local.set({ [REMOVED_TRAINED_KEY]: [...cur, id] });
}

/** Forgets that the user removed these trained groups (they picked them again in the interests step). */
export async function forgetRemovedTrained(ids: string[]): Promise<void> {
  const cur = await loadRemovedTrained();
  const next = cur.filter((id) => !ids.includes(id));
  if (next.length !== cur.length) await chrome.storage.local.set({ [REMOVED_TRAINED_KEY]: next });
}
/** The lower-cased name a trained group is created with. */
function trainedName(id: string): string {
  return (STARTER_GROUPS.find((g) => g.id === id)?.name ?? '').toLowerCase();
}
/**
 * Whether `i` counts toward growing the group it wants: auto-placed, left in Unsorted or parked in Videos, and
 * wanting a trained on-demand id. (`want` can be stale after a regroup or an import moved the item: those
 * conditions keep a stale value from counting.)
 */
function wants(i: Item): string | null {
  if (i.groupSource !== 'auto' || !i.classifiable) return null;
  if (i.groupId !== null && i.groupId !== VIDEOS_GROUP_ID) return null;
  return i.want !== undefined && TRAINED_IDS.has(i.want) ? i.want : null;
}

/**
 * Creates each trained group that GROW_MIN auto-placed tabs want and that is missing, not removed by the user and
 * whose name no group of the user's already has, and moves those tabs into it (groupSource stays 'auto', `want`
 * cleared). The seeds are embedded (for the centroid) only for groups about to be created, before the write; the
 * write re-reads every item and group and skips anything that changed meanwhile. Returns the groups created.
 */
export async function growGroups(
  db: Db,
  embedFn: (t: string[]) => Promise<Float32Array[]>,
  now = Date.now(),
): Promise<Group[]> {
  const [items, groups] = await Promise.all([db.items.all(), db.groups.all()]);
  const byWant = new Map<string, string[]>();
  for (const i of items) {
    const w = wants(i);
    if (w !== null) byWant.set(w, [...(byWant.get(w) ?? []), i.id]);
  }
  const ready = [...byWant].filter(([, ids]) => ids.length >= GROW_MIN);
  if (!ready.length) return [];
  const removed = new Set(await loadRemovedTrained());
  const existing = new Set(groups.map((g) => g.id));
  const names = new Set(groups.filter((g) => !g.suggested).map((g) => g.name.toLowerCase()));
  const todo = ready.filter(([id]) => !removed.has(id) && !existing.has(id) && !names.has(trainedName(id)));
  if (!todo.length) return [];
  // Embedding is not an IndexedDB request: it must finish before the transaction opens.
  const built: { group: Group; ids: string[] }[] = [];
  for (const [id, ids] of todo) built.push({ group: { ...(await buildTrainedGroup(id, embedFn)), createdAt: now, grownAt: now }, ids });

  return db.tx(['items', 'groups'], async (s) => {
    const all = await s.groups.all();
    const ids = new Set(all.map((g) => g.id));
    // Names stay unique (sync and tab-group mirroring match groups by name; suggestions don't count).
    const names = new Set(all.filter((g) => !g.suggested).map((g) => g.name.toLowerCase()));
    const made: Group[] = [];
    for (const { group, ids: itemIds } of built) {
      if (ids.has(group.id) || names.has(group.name.toLowerCase())) continue;
      const fresh: Item[] = [];
      for (const id of itemIds) {
        const cur = await s.items.get(id);
        if (cur && wants(cur) === group.id) fresh.push(cur);
      }
      if (fresh.length < GROW_MIN) continue; // tabs taken meanwhile: not enough left to need the group
      await s.groups.put(group);
      for (const cur of fresh) {
        const { want: _w, ...rest } = cur;
        void _w;
        await s.items.put({ ...rest, groupId: group.id, updatedAt: nextStamp(cur.updatedAt, now) });
      }
      ids.add(group.id);
      names.add(group.name.toLowerCase());
      made.push(group);
    }
    return made;
  });
}

/**
 * How long a sync pull or an import waits for the seeds of a trained group to embed. On a just-launched profile the
 * offscreen model loads cold; past this the group is made without a centroid (fillTrainedCentroids adds it later).
 */
export const SEED_EMBED_TIMEOUT_MS = 3000;
/** `p`, or a rejection once `ms` have passed (the work itself goes on; its result is dropped). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
/**
 * The trained groups that groups arriving by name (sync, backup) should become: for each name that matches a seed
 * group's name (case-insensitive) while no group has that name or that id, the group built from its seeds
 * (keyed by the lower-cased name). The seeds are embedded here, so call it before opening a transaction. When
 * embedding fails or takes longer than `timeoutMs` (or there is no `embedFn`) the group is still built, with no
 * centroid, and the rest are built without trying again; it never blocks the caller for long.
 */
export async function trainedGroupsForNames(
  db: Db,
  names: string[],
  embedFn?: (t: string[]) => Promise<Float32Array[]>,
  timeoutMs = SEED_EMBED_TIMEOUT_MS,
): Promise<Map<string, Group>> {
  let model = embedFn;
  const out = new Map<string, Group>();
  const groups = (await db.groups.all()).filter((g) => !g.suggested);
  const haveName = new Set(groups.map((g) => g.name.toLowerCase()));
  const haveId = new Set((await db.groups.all()).map((g) => g.id));
  for (const name of names) {
    const key = name.toLowerCase();
    const id = trainedIdForName(name);
    if (id === null || out.has(key) || haveName.has(key) || haveId.has(id)) continue;
    let g: Group;
    try {
      if (!model) throw new Error('no embedder');
      g = await within(buildTrainedGroup(id, model), timeoutMs);
    } catch {
      model = undefined; // cold or failing: the other names don't wait for it again
      const seed = STARTER_GROUPS.find((x) => x.id === id)!;
      g = { id, name: seed.name, color: seed.color, icon: seed.icon, builtIn: true, exemplars: [], centroid: null, createdAt: Date.now() };
    }
    out.set(key, g);
  }
  return out;
}

/**
 * Gives each trained group that has no centroid (made while the model was cold, see trainedGroupsForNames) the
 * centroid of its seeds. Only the centroid is written, and only while it is still null; a group whose seeds fail
 * to embed waits for a later pass. Never throws. Returns how many groups got one.
 */
export async function fillTrainedCentroids(
  db: Db,
  embedFn: (t: string[]) => Promise<Float32Array[]>,
): Promise<number> {
  try {
    const todo = (await db.groups.all()).filter((g) => TRAINED_IDS.has(g.id) && g.centroid === null && !g.suggested);
    if (!todo.length) return 0;
    const built = new Map<string, number[]>();
    for (const g of todo) {
      const c = (await buildTrainedGroup(g.id, embedFn).catch(() => null))?.centroid;
      if (c) built.set(g.id, c);
    }
    if (!built.size) return 0;
    return await db.tx(['groups'], async (s) => {
      let n = 0;
      for (const [id, centroid] of built) {
        const cur = await s.groups.get(id);
        if (!cur || cur.centroid !== null) continue; // gone, or given one meanwhile
        await s.groups.put({ ...cur, centroid });
        n++;
      }
      return n;
    });
  } catch (e) {
    console.error('filling trained centroids failed', e);
    return 0;
  }
}
