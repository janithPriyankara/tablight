// The Priority group: only the user puts tabs there (the star, the Alt+P shortcut, or moving a tab into it). Nothing
// is taught to it, and no automatic step places a tab in it or takes one out (classify/pick.ts, tab-index.ts).
import type { Group, Item } from '../shared/types';
import {
  PRIORITIZE_COMMAND, PRIORITY_GROUP_ID, UNPRIORITIZE_COMMAND, isPriorityName, newPriorityGroup, type PriorityCommand,
} from '../shared/priority';
import { isWebUrl } from '../shared/url';
import { nextStamp } from '../shared/stamp';
import type { Db, StoreApis } from './db';
import { remapUndoGroups } from './memory';
import { withoutPlacedBy } from './tab-index';

type Stores = Pick<StoreApis, 'items' | 'groups'>;

/**
 * Creates the Priority group inside a transaction when it is missing. A group of the user's that already has the
 * name (made before Priority existed, from a backup or another device) becomes it: its tabs move in (with no group to
 * go back to) and that group goes; what was taught to it is dropped, since Priority never learns. Returns the id of the
 * group it replaced, if any.
 */
export async function ensurePriorityIn(s: Stores, now = Date.now()): Promise<string | null> {
  if (await s.groups.get(PRIORITY_GROUP_ID)) return null;
  const holder = (await s.groups.all()).find((g) => !g.suggested && isPriorityName(g.name));
  await s.groups.put(newPriorityGroup(now));
  if (!holder) return null;
  for (const i of await s.items.all()) {
    if (i.groupId !== holder.id) continue;
    await s.items.put({ ...withoutPlacedBy(i), groupId: PRIORITY_GROUP_ID, groupSource: 'user', updatedAt: nextStamp(i.updatedAt, now) });
  }
  await s.groups.delete(holder.id);
  return holder.id;
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
  let replaced: string | null = null;
  const added = await db.tx(['items', 'groups', 'queue'], async (s) => {
    const now = Date.now();
    replaced = await ensurePriorityIn(s, now);
    let n = 0;
    for (const id of unique) {
      const cur = await s.items.get(id);
      if (!cur || cur.groupId === PRIORITY_GROUP_ID) continue;
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
  if (replaced !== null) remapUndoGroups(new Map([[replaced, PRIORITY_GROUP_ID]]));
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
 * when the tab is not indexed yet (it just opened). `kick` runs classification after a removal queued the tab.
 */
export async function runPriorityCommand(
  db: Db, command: PriorityCommand, tab: chrome.tabs.Tab | undefined,
  deps: { catchUp: () => Promise<void>; kick: (db: Db) => void },
): Promise<CommandResult> {
  if (!commandTab(tab)) return 'none';
  let item = await db.items.byTabId(tab.id);
  if (!item || item.state === 'stashed') {
    await deps.catchUp();
    item = await db.items.byTabId(tab.id);
  }
  if (!item || item.state === 'stashed') return 'none';
  if (command === PRIORITIZE_COMMAND) return (await prioritize(db, [item.id])) ? 'added' : 'none';
  const { removed, queued } = await unprioritize(db, [item.id]);
  if (queued) deps.kick(db);
  return removed ? 'removed' : 'none';
}
/** Badge text shown for a moment on the tab after a shortcut changed it. */
export const COMMAND_BADGE: Record<Exclude<CommandResult, 'none'>, string> = { added: '★', removed: '–' };
