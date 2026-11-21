// The Priority group: one built-in group that only the user fills (the star, Alt+P). Shared by the background, the
// classifier (which must never place a tab there) and the UI (which lists it first).
import type { Group, Item } from './types';

/** The fixed id of the Priority group. */
export const PRIORITY_GROUP_ID = 'priority';
/** Its fixed name: it cannot be renamed, and no other group may take it (sync and backups match groups by name). */
export const PRIORITY_NAME = 'Priority';
/** An amber that maps to Chrome's yellow tab-group colour. */
export const PRIORITY_COLOR = '#c99a00';
export const PRIORITY_ICON = '⭐';
/**
 * chrome.storage.local: the new names of user groups renamed because "Priority" became the built-in group's name
 * (string[]). The dashboard shows a one-time notice for them and removes the key when it is dismissed.
 */
export const PRIORITY_RENAMED_KEY = 'priorityRenamed';
/** Shown when the user tries to give another group the name "Priority" (create, rename). */
export const RESERVED_NAME_MESSAGE = '“Priority” is the built-in group you fill yourself. Choose another name.';
/** The manifest's commands: add the current tab to Priority (Alt+P), remove it (Alt+Shift+P). */
export const PRIORITIZE_COMMAND = 'prioritize-tab';
export const UNPRIORITIZE_COMMAND = 'unprioritize-tab';
export type PriorityCommand = typeof PRIORITIZE_COMMAND | typeof UNPRIORITIZE_COMMAND;

export const isPriority = (i: Pick<Item, 'groupId'>): boolean => i.groupId === PRIORITY_GROUP_ID;
/** Whether `name` is the Priority group's name (any case). */
export const isPriorityName = (name: string): boolean => name.trim().toLowerCase() === PRIORITY_NAME.toLowerCase();

/** A new, empty Priority group. Nothing is ever taught to it: no exemplars, lessons or centroid. */
export function newPriorityGroup(now = Date.now()): Group {
  return {
    id: PRIORITY_GROUP_ID, name: PRIORITY_NAME, color: PRIORITY_COLOR, icon: PRIORITY_ICON, builtIn: true,
    exemplars: [], centroid: null, createdAt: now,
  };
}
/** Groups the automatic pipeline may pick from: every group but Priority. */
export function withoutPriority<G extends { id: string }>(groups: G[]): G[] {
  return groups.some((g) => g.id === PRIORITY_GROUP_ID) ? groups.filter((g) => g.id !== PRIORITY_GROUP_ID) : groups;
}
