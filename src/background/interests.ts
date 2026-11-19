// The interests step: the user picks the topics they browse most, and that creates the matching groups.
import { OTHER_GROUP_ID, buildTrainedGroup } from '../classify/assign';
import { INTEREST_CHOICES, STARTER_GROUPS } from '../classify/seeds';
import { nextStamp } from '../shared/stamp';
import type { Group } from '../shared/types';
import type { Db } from './db';
import { MIRRORED_KEY, loadMirrored, newUserGroup, parseIds, parseName } from './groups';
import { forgetRemovedTrained } from './grow';

/** chrome.storage.local: the last answer to the interests step, `{ picked: string[]; custom: string[] }`. */
export const INTERESTS_KEY = 'interests';

const CHOICE_IDS: ReadonlySet<string> = new Set(INTEREST_CHOICES.map((c) => c.id));
/** A choice's id by its lower-cased name, so "Add your own: sports" means the trained Sports group. */
const CHOICE_BY_NAME = new Map(INTEREST_CHOICES.map((c) => [c.name.toLowerCase(), c.id]));
/** The groups created at install (Other is permanent and never offered). */
const INSTALLED = STARTER_GROUPS.filter((g) => !g.onDemand && g.id !== OTHER_GROUP_ID);

export interface InterestsRequest { picked: string[]; custom: string[] }

/**
 * Applies the interests step's answer.
 * - Each picked choice (unknown ids are ignored) gets its group with the seed id and `builtIn: true`: created from
 *   its seeds, or, when a user group already has that name (any case), that group is adopted under the seed id
 *   (its tabs, lessons, colour and name kept). A built-in group that holds the name blocks it. A picked trained
 *   group is no longer remembered as removed, so it may grow on the fly again.
 * - Each custom name is validated like a group name. One that names a choice counts as picking it; one that an
 *   existing group already has (any case) adds nothing; any other becomes a new user group.
 * - `fresh` (first answer on a new install): each installed group not picked is removed when the user hasn't
 *   touched it: no user-placed tab in it (in any state), its seed name, not mirrored as a native tab group, and
 *   nothing taught to it (no exemplars or lessons). Its tabs go back to Unsorted. Otherwise nothing is removed.
 * - Every auto-placed classifiable tab (outside pending suggestions) is queued for classification, so the new
 *   groups fill at once; user-placed tabs stay. The caller kicks classification.
 * - `interestsAnswered` becomes true and the answer is stored under INTERESTS_KEY.
 * Returns the ids of the groups created and removed.
 */
export async function applyInterests(
  db: Db,
  embedFn: (t: string[]) => Promise<Float32Array[]>,
  req: InterestsRequest,
  fresh: boolean,
): Promise<{ created: string[]; removed: string[] }> {
  const picked = new Set(parseIds(req.picked).filter((id) => CHOICE_IDS.has(id)));
  const custom: string[] = [];
  for (const raw of parseIds(req.custom)) {
    const name = parseName(raw);
    const choice = CHOICE_BY_NAME.get(name.toLowerCase());
    if (choice !== undefined) picked.add(choice);
    else if (!custom.some((c) => c.toLowerCase() === name.toLowerCase())) custom.push(name);
  }
  await forgetRemovedTrained([...picked]);

  // Embedding is not an IndexedDB request: the missing groups are built before the transaction opens.
  const have = new Set((await db.groups.all()).map((g) => g.id));
  const built = new Map<string, Group>();
  for (const id of picked) if (!have.has(id)) built.set(id, await buildTrainedGroup(id, embedFn));
  const mirrored = new Set((await loadMirrored()).values());

  const moved = new Map<string, string>(); // adopted group: old id -> seed id
  const result = await db.tx(['items', 'groups', 'queue', 'settings'], async (s) => {
    const all = await s.groups.all();
    const named = (name: string): Group | undefined =>
      all.find((g) => !g.suggested && g.name.toLowerCase() === name.toLowerCase());
    const created: string[] = [];
    const removed: string[] = [];

    for (const id of picked) {
      const seed = built.get(id);
      if (!seed || all.some((g) => g.id === id)) continue;
      const holder = named(seed.name);
      if (holder?.builtIn) continue; // a built-in group (renamed) holds the name: names stay unique
      if (holder) {
        const adopted: Group = { ...holder, id, builtIn: true, centroid: holder.centroid ?? seed.centroid };
        await s.groups.delete(holder.id);
        await s.groups.put(adopted);
        for (const i of await s.items.all()) {
          if (i.groupId === holder.id) await s.items.put({ ...i, groupId: id, updatedAt: nextStamp(i.updatedAt) });
        }
        all.splice(all.indexOf(holder), 1, adopted);
        moved.set(holder.id, id);
        continue;
      }
      await s.groups.put(seed);
      all.push(seed);
      created.push(id);
    }
    for (const name of custom) {
      if (named(name)) continue;
      const g = newUserGroup(name, all.length);
      await s.groups.put(g);
      all.push(g);
      created.push(g.id);
    }

    if (fresh) {
      const items = await s.items.all();
      const userPlaced = new Set(items.flatMap((i) => (i.groupSource === 'user' && i.groupId !== null ? [i.groupId] : [])));
      for (const seed of INSTALLED) {
        if (picked.has(seed.id)) continue;
        const g = all.find((x) => x.id === seed.id);
        if (!g?.builtIn || g.name !== seed.name || userPlaced.has(g.id) || mirrored.has(g.id)) continue;
        if (g.exemplars.length || g.lessons?.length) continue;
        for (const i of items) {
          if (i.groupId === g.id) await s.items.put({ ...i, groupId: null, groupSource: 'auto', updatedAt: nextStamp(i.updatedAt) });
        }
        await s.groups.delete(g.id);
        removed.push(g.id);
      }
    }

    const suggested = new Set(all.filter((g) => g.suggested).map((g) => g.id));
    for (const i of await s.items.all()) {
      if (!i.classifiable || i.groupSource !== 'auto') continue;
      if (i.groupId !== null && suggested.has(i.groupId)) continue; // a pending suggestion stays as it is
      await s.queue.add(i.id);
    }
    await s.settings.set({ interestsAnswered: true });
    return { created, removed };
  });

  if (moved.size) {
    // The native tab group mirroring an adopted group keeps following it under its new id.
    const map = await loadMirrored();
    for (const [nid, gid] of map) if (moved.has(gid)) map.set(nid, moved.get(gid)!);
    await chrome.storage.session.set({ [MIRRORED_KEY]: Object.fromEntries(map) }).catch(() => undefined);
  }
  await chrome.storage.local.set({ [INTERESTS_KEY]: { picked: [...picked], custom } });
  return result;
}
