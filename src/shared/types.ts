import type { SuspiciousTab } from './clues';
export type ItemState = 'open' | 'sleeping' | 'stashed';
export type Kind = 'watch' | 'read' | 'other';
/** How the automatic pipeline placed a tab (classify/pick.ts). */
export type PlacedBy = 'rule' | 'exemplar' | 'name' | 'head' | 'neighbour' | 'youtube' | 'videos';
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
  /** Local only (never synced or exported, no updatedAt bump): the topic the classifier wanted but no group existed for. */
  want?: string;
  /**
   * Local only (never synced or exported, no updatedAt bump): how the automatic pipeline placed the tab, written with
   * every automatic pick and removed when the user places it. Tabs placed by a neighbour, the YouTube bar or Videos
   * never count as neighbours themselves (tab-index neighbourPool), so a guess never feeds more guesses.
   */
  placedBy?: PlacedBy;
  /**
   * Local only (never synced or exported, no updatedAt bump): the current automatic placement came from a re-pick after
   * a model change (model-change.ts quiet queue entries) and was never stamped, so it stays on this device: growGroups
   * keeps it unstamped too. Removed by any user placement (withoutPlacedBy) and by a stamped automatic move.
   */
  quietPick?: true;
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
  /** When a trained group was created on the fly because tabs needed it (grow.ts); absent for every other group. */
  grownAt?: number;
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
  /** Flag open tabs that look like ad or scam pop-ups (the toolbar badge shows '!'). */
  suspiciousTabs: boolean;
  /**
   * The interests step was answered (Continue or Skip). False on a fresh install, after "Delete all data", and for
   * installs from before the step (their stored settings lack the key), so the one-time card shows once.
   */
  interestsAnswered: boolean;
  /**
   * The next interests answer is the first on a new install (set by onInstalled 'install' and "Delete all data";
   * cleared by any answer, Continue or Skip): only then may it remove untouched installed groups. False by default,
   * so an install upgraded from an older version (stored settings lack the key) only adds groups. Not a user setting.
   */
  interestsFresh: boolean;
  /**
   * Show the "Look it up" action on Unsorted rows (dashboard and side panel). On by default; stored settings from
   * before it lack the key and read as on (db.readSettings merges DEFAULT_SETTINGS). Nothing is sent without the
   * confirm dialog either way.
   */
  lookupButton: boolean;
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
  suspiciousTabs: true,
  interestsAnswered: false,
  interestsFresh: false,
  lookupButton: true,
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
  /** The active tab of every window (the dashboard marks it "Now"). */
  activeTabIds: number[];
  /** The last-focused window's active tab, when it has duplicates. */
  activeDup?: { item: Item; others: Item[] };
  /** Open or sleeping tabs that look like ad or scam pop-ups; empty when the setting is off. */
  suspicious: SuspiciousTab[];
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
/**
 * chrome.storage.local key of the opt-in look-up's answers (src/ui/common/lookup.ts): cleaned text -> { at, hits }.
 * Local only: never synced or exported, removed by "Delete all data".
 */
export const LOOKUP_CACHE_KEY = 'lookupCache';
/** The background's broadcast to open extension pages after data changed (debounced). */
export interface ChangedMessage { target: 'ui'; t: 'changed' }
/** The worker's broadcast after "Delete all data": open pages drop what they would still write (the look-up cache). */
export interface ResetMessage { target: 'ui'; t: 'reset' }
