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
  /**
   * Local only: false while the tab has never been the active tab since it appeared ("New"); true once it has.
   * Missing (older data, tabs whose past is unknown) counts as opened.
   */
  opened?: boolean;
}
export interface Group {
  id: string;
  name: string;
  color: string;
  icon: string;
  builtIn: boolean;
  exemplars: number[][];
  /**
   * What the user taught this group: [the text the model read for the tab, taught at (ms)], newest last.
   * Synced (lesson-codec) so the same bundled model on other devices learns the same examples.
   */
  lessons?: [text: string, at: number][];
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
  /** Found topics become groups right away instead of waiting as suggestions. */
  autoCreateGroups: boolean;
  /** What a click on the toolbar icon opens. */
  toolbarOpens: 'popup' | 'sidepanel';
}
export const DEFAULT_SETTINGS: Settings = {
  autoSleepMinutes: null,
  syncEnabled: true,
  mirrorTabGroups: false,
  removeOnOpen: true,
  theme: 'system',
  onboarded: false,
  autoCreateGroups: false,
  toolbarOpens: 'popup',
};
/**
 * Outcome of the last stash sync, kept in chrome.storage.local under "syncStatus" for the UI.
 * lastSyncAt is the time of the last successful sync (kept across failures), null if never.
 */
export type SyncStatus = (
  | { ok: true; synced: number; localOnly: number }
  | { ok: false; reason: 'quota' | 'disabled' | 'rate' | 'error'; message: string }
) & { lastSyncAt: number | null };
/** A group as the UI sees it: exemplars and centroid are emptied (vectors never leave the worker). */
export type GroupSummary = Group & {
  /** Items in the group, in any state (open, sleeping or stashed). */
  count: number;
  /** Of those, the ones whose kind is 'watch'. */
  watchCount: number;
};
/** Reply of the `state` RPC: everything the popup and dashboard render. */
export interface DashboardState {
  items: Item[];
  groups: GroupSummary[];
  /** Extra copies: for every set of duplicate tabs, its size minus one. */
  dupCount: number;
  /** Distinct windows holding open or sleeping items. */
  windows: number;
  sleeping: number;
  /** The last-focused window's active tab, when it has duplicates. */
  activeDup?: { item: Item; others: Item[] };
  syncStatus: SyncStatus;
  /** The previous browser session, when the startup check found it was not restored. */
  lastSession?: Snapshot;
  /** Nothing waits for classification, or (with groups to classify into) the model produced a vector this session. */
  modelReady: boolean;
  /** Items waiting for classification (the queue size). */
  queued: number;
  settings: Settings;
}
/** chrome.storage.session key of the startup check's result: `{ snapshotId: string | null }`. */
export const LAST_SESSION_KEY = 'lastSession';
/** The background's broadcast to open extension pages after data changed (debounced). */
export interface ChangedMessage { target: 'ui'; t: 'changed' }
