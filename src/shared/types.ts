export type ItemState = 'open' | 'sleeping' | 'stashed';
export type Kind = 'watch' | 'read' | 'other';
export interface Item {
  id: string;
  url: string;
  normUrl: string;
  title: string;
  domain: string;
  state: ItemState;
  tabId?: number;
  windowId?: number;
  groupId: string | null;
  groupSource: 'auto' | 'user';
  kind: Kind;
  createdAt: number;
  lastActiveAt: number;
  stashedAt?: number;
  updatedAt: number;
  classifiable: boolean;
  /** Embedding cache key of the content last classified (lets search read vectors without hashing). */
  embKey?: string;
  /** Local only (never synced or exported, no updatedAt bump): when embedding this item was given up on. */
  embGaveUpAt?: number;
}
export interface Group {
  id: string;
  name: string;
  color: string;
  icon: string;
  builtIn: boolean;
  exemplars: number[][];
  centroid: number[] | null;
  createdAt: number;
  suggested?: boolean;
}
export interface Snapshot {
  id: string;
  takenAt: number;
  windows: { tabs: { url: string; title: string }[] }[];
}
export interface Settings {
  autoSleepMinutes: number | null;
  syncEnabled: boolean;
  mirrorTabGroups: boolean;
  removeOnOpen: boolean;
  theme: 'system' | 'light' | 'dark';
  onboarded: boolean;
}
export const DEFAULT_SETTINGS: Settings = {
  autoSleepMinutes: null,
  syncEnabled: true,
  mirrorTabGroups: false,
  removeOnOpen: true,
  theme: 'system',
  onboarded: false,
};
/**
 * Outcome of the last stash sync, kept in chrome.storage.local under "syncStatus" for the UI.
 * lastSyncAt is the time of the last successful sync (kept across failures), null if never.
 */
export type SyncStatus = (
  | { ok: true; synced: number; localOnly: number }
  | { ok: false; reason: 'quota' | 'disabled' | 'rate' | 'error'; message: string }
) & { lastSyncAt: number | null };
