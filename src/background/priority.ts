// The Priority group: only the user puts tabs there (the star, the Alt+P shortcut, or moving a tab into it). Nothing
// is taught to it, and no automatic step places a tab in it or takes one out (classify/pick.ts, tab-index.ts).
import type { Group, Item } from '../shared/types';
import {
  PRIORITIZE_COMMAND, PRIORITY_GROUP_ID, PRIORITY_NAME, PRIORITY_RENAMED_KEY, UNPRIORITIZE_COMMAND, isPriorityName, newPriorityGroup,
  type PriorityCommand,
} from '../shared/priority';
import { isWebUrl, normalizeUrl } from '../shared/url';
import { nextStamp } from '../shared/stamp';
import type { Db, StoreApis } from './db';
import { withoutPlacedBy } from './tab-index';

type Stores = Pick<StoreApis, 'items' | 'groups'>;
/**
 * Within a transaction that holds `items`: each Priority tab whose remembered group moved to a new id (a merge, an
 * interests adoption) follows it, so removing it from Priority still finds that group.
 */
export async function remapBeforePriority(s: Pick<StoreApis, 'items'>, moved: ReadonlyMap<string, string>): Promise<void> {
  if (!moved.size) return;
  for (const i of await s.items.all()) {
    const was = i.beforePriority?.groupId;
    if (i.groupId !== PRIORITY_GROUP_ID || was == null || !moved.has(was)) continue;
    await s.items.put({ ...i, beforePriority: { ...i.beforePriority!, groupId: moved.get(was)! } }); // local field: no stamp
  }
}

export { PRIORITY_RENAMED_KEY };
/** The name a user group called "Priority" (any case) gets: "Priority (yours)", then "Priority (yours) 2", … */
export function freeReservedName(groups: Pick<Group, 'name'>[]): string {
  const taken = new Set(groups.map((g) => g.name.toLowerCase()));
  const base = `${PRIORITY_NAME} (yours)`;
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}
/**
 * Inside a transaction: renames every group other than the built-in Priority that is called "Priority" (any case),
 * suggestions included, to "Priority (yours)" (numbered when taken). Its id, examples, lessons and tabs stay as they
 * are; its saved tabs get a new sync stamp so the new name wins on other devices (as a rename does). Returns the
 * renames of groups the user had (not suggestions), for the one-time notice.
 */
export async function renameReservedIn(s: Stores, now = Date.now()): Promise<{ id: string; name: string }[]> {
  const all = await s.groups.all();
  const holders = all.filter((g) => g.id !== PRIORITY_GROUP_ID && isPriorityName(g.name));
  const out: { id: string; name: string }[] = [];
  for (const g of holders) {
    const name = freeReservedName(all);
    const next = { ...g, name };
    all.splice(all.indexOf(g), 1, next);
    await s.groups.put(next);
    if (g.suggested) continue; // unaccepted suggestions never sync and were never the user's
    out.push({ id: g.id, name });
    for (const i of await s.items.byState('stashed')) {
      if (i.groupId === g.id) await s.items.put({ ...i, updatedAt: nextStamp(i.updatedAt, now) });
    }
  }
  return out;
}
/** Records the renames for the dashboard's one-time notice (kept until dismissed). Never throws. */
export async function noteRenamed(renamed: { name: string }[]): Promise<void> {
  if (!renamed.length) return;
  try {
    const cur = (await chrome.storage.local.get(PRIORITY_RENAMED_KEY))[PRIORITY_RENAMED_KEY];
    const had = Array.isArray(cur) ? cur.filter((x): x is string => typeof x === 'string') : [];
    await chrome.storage.local.set({ [PRIORITY_RENAMED_KEY]: [...new Set([...had, ...renamed.map((r) => r.name)])] });
  } catch {
    // the rename stands; only the notice is lost
  }
}
/**
 * The one-time migration (update, worker start, before each sync and before Priority is created): a group called
 * "Priority" that is not the built-in one (made by the user, by topic discovery, or by an older version's sync) is
 * renamed, never taken over. Returns how many groups were renamed.
 */
export async function migrateReservedName(db: Db): Promise<number> {
  if (!(await db.groups.all()).some((g) => g.id !== PRIORITY_GROUP_ID && isPriorityName(g.name))) return 0;
  const renamed = await db.tx(['items', 'groups'], (s) => renameReservedIn(s));
  await noteRenamed(renamed);
  return renamed.length;
}

/**
 * Creates the Priority group inside a transaction when it is missing (empty: nothing is moved into it). A group that
 * holds the name is renamed first (renameReservedIn). Returns those renames.
 */
export async function ensurePriorityIn(s: Stores, now = Date.now()): Promise<{ id: string; name: string }[]> {
  if (await s.groups.get(PRIORITY_GROUP_ID)) return [];
  const renamed = await renameReservedIn(s, now);
  await s.groups.put(newPriorityGroup(now));
  return renamed;
}
/** The Priority group as a name match for sync and import: the existing one, or a new one to store. */
export function priorityForName(groups: Group[]): Group {
  return groups.find((g) => g.id === PRIORITY_GROUP_ID) ?? newPriorityGroup();
}

/**
 * Adds items to Priority as the user's choice. Each remembers where it was (beforePriority) so removing it puts it
 * back. Teaches nothing. Items already in Priority are left as they are. Returns how many were added.
 */
export async function prioritize(db: Db, ids: string[]): Promise<number> {
  const unique = [...new Set(ids)];
  let renamed: { id: string; name: string }[] = [];
  const added = await db.tx(['items', 'groups', 'queue'], async (s) => {
    const now = Date.now();
    renamed = await ensurePriorityIn(s, now);
    let n = 0;
    for (const id of unique) {
      const cur = await s.items.get(id);
      // Web pages only, like the shortcut: browser pages are never in Priority.
      if (!cur || !cur.classifiable || cur.groupId === PRIORITY_GROUP_ID) continue;
      const before: NonNullable<Item['beforePriority']> = {
        groupId: cur.groupId, groupSource: cur.groupSource,
        ...(cur.groupSource === 'auto' && cur.placedBy !== undefined ? { placedBy: cur.placedBy } : {}),
      };
      await s.items.put({
        ...withoutPlacedBy(cur), groupId: PRIORITY_GROUP_ID, groupSource: 'user', beforePriority: before,
        updatedAt: nextStamp(cur.updatedAt, now),
      });
      await s.queue.remove([id]); // a pending classification would change nothing: the user's choice stands
      n++;
    }
    return n;
  });
  await noteRenamed(renamed);
  return added;
}

/**
 * Takes items out of Priority: each goes back to the group it was in before (as it was placed there, by the user or
 * automatically) when that group still exists and is not a suggestion that has gone; otherwise it becomes Unsorted
 * and is queued, so the pipeline places it as it would a new tab. Items not in Priority are left as they are.
 * Returns how many were removed and how many were queued (the caller kicks classification for those).
 */
export async function unprioritize(db: Db, ids: string[]): Promise<{ removed: number; queued: number }> {
  const unique = [...new Set(ids)];
  return db.tx(['items', 'groups', 'queue'], async (s) => {
    const now = Date.now();
    const known = new Set((await s.groups.all()).map((g) => g.id));
    let removed = 0;
    let queued = 0;
    for (const id of unique) {
      const cur = await s.items.get(id);
      if (!cur || cur.groupId !== PRIORITY_GROUP_ID) continue;
      const before = cur.beforePriority;
      const back = before && before.groupId !== null && before.groupId !== PRIORITY_GROUP_ID && known.has(before.groupId)
        ? before : null;
      const base = withoutPlacedBy(cur);
      const updatedAt = nextStamp(cur.updatedAt, now);
      if (back) {
        await s.items.put({
          ...base, groupId: back.groupId, groupSource: back.groupSource, updatedAt,
          ...(back.groupSource === 'auto' && back.placedBy !== undefined ? { placedBy: back.placedBy } : {}),
        });
      } else {
        await s.items.put({ ...base, groupId: null, groupSource: 'auto', updatedAt });
        if (cur.classifiable) {
          await s.queue.add(id);
          queued++;
        }
      }
      removed++;
    }
    return { removed, queued };
  });
}

export const isPriorityCommand = (c: string): c is PriorityCommand => c === PRIORITIZE_COMMAND || c === UNPRIORITIZE_COMMAND;
/** What a Priority shortcut did. */
export type CommandResult = 'added' | 'removed' | 'none';
/**
 * The tab a shortcut may act on: a web page (http or https) in a normal window. Tablight's own pages, browser pages
 * (chrome://, the new tab page) and incognito tabs are left alone.
 */
export function commandTab(tab: chrome.tabs.Tab | undefined): tab is chrome.tabs.Tab & { id: number } {
  if (!tab || tab.id === undefined || tab.id < 0 || tab.incognito) return false;
  return isWebUrl(tab.url || tab.pendingUrl || '');
}
/**
 * The Alt+P / Alt+Shift+P shortcuts on `tab`: adds its item to Priority or removes it. Adding a tab already in Priority,
 * removing one that is not, and any tab commandTab refuses do nothing. `catchUp` brings the tab index up to date
 * (a reconcile, without waiting for classification) when the tab is not indexed yet (it just opened) or its record is
 * of another page (stale ids after a restart). The caller runs commands one at a time, in the order pressed. `kick` runs classification after a removal queued the tab.
 */
export async function runPriorityCommand(
  db: Db, command: PriorityCommand, tab: chrome.tabs.Tab | undefined,
  deps: { catchUp: () => Promise<void>; kick: (db: Db) => void },
): Promise<CommandResult> {
  if (!commandTab(tab)) return 'none';
  // The item must be this tab's page: right after a browser restart, tab ids start again from small numbers, and an
  // item of the previous session can still hold this id until the index catches up.
  const norm = normalizeUrl(tab.url || tab.pendingUrl || '');
  const mine = (i: Item | undefined): i is Item => i !== undefined && i.state !== 'stashed' && i.normUrl === norm;
  let item = await db.items.byTabId(tab.id);
  if (!mine(item)) {
    await deps.catchUp();
    item = await db.items.byTabId(tab.id);
  }
  if (!mine(item)) return 'none';
  if (command === PRIORITIZE_COMMAND) return (await prioritize(db, [item.id])) ? 'added' : 'none';
  const { removed, queued } = await unprioritize(db, [item.id]);
  if (queued) deps.kick(db);
  return removed ? 'removed' : 'none';
}
/** Badge text shown for a moment on the tab after a shortcut changed it. */
export const COMMAND_BADGE: Record<Exclude<CommandResult, 'none'>, string> = { added: '★', removed: '–' };
