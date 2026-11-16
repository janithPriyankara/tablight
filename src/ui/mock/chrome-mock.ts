/**
 * In-page fake of the chrome.* APIs the extension uses: for unit tests and the in-browser UI preview.
 * Events dispatch synchronously, in the same order Chrome fires them, so tests can drive tab storms
 * deterministically. Control methods (addTab, removeTab, …) change the fake browser and fire events.
 * Not used by the shipped extension.
 */

type Tab = chrome.tabs.Tab;
type Alarm = chrome.alarms.Alarm;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (...args: any[]) => void;

export class MockEvent<T extends Fn> {
  private listeners: T[] = [];
  addListener(cb: T): void {
    if (!this.listeners.includes(cb)) this.listeners.push(cb);
  }
  removeListener(cb: T): void {
    this.listeners = this.listeners.filter((l) => l !== cb);
  }
  hasListener(cb: T): boolean {
    return this.listeners.includes(cb);
  }
  all(): T[] {
    return [...this.listeners];
  }
  hasListeners(): boolean {
    return this.listeners.length > 0;
  }
  /** Calls every listener with `args`. A listener that throws doesn't stop the others (like Chrome). */
  fire(...args: Parameters<T>): void {
    for (const l of [...this.listeners]) {
      try {
        l(...args);
      } catch (e) {
        console.error('mock listener threw', e);
      }
    }
  }
}

export interface MockSeed {
  windows: { tabs: Partial<Tab>[] }[];
}

export interface ChromeMockControl {
  /** The installed fake, typed as the subset implemented here. */
  readonly chrome: MockChrome;
  /** Live copies of every tab, in window then index order. */
  tabs(): Tab[];
  windowIds(): number[];
  /** Opens an empty window and returns its id (windows.onCreated is not modelled). */
  addWindow(): number;
  /** Closes a window: every tab fires onRemoved with isWindowClosing, then windows.onRemoved. */
  removeWindow(windowId: number): void;
  /** Creates a tab (onCreated). `windowId` defaults to the first window, which is created if none exists. */
  addTab(props?: Partial<Tab>): Tab;
  removeTab(tabId: number): void;
  /** Changes a tab and fires onUpdated with the changed url/title/status/discarded/pinned/audible fields. */
  updateTab(tabId: number, change: Partial<Tab>): Tab;
  /** Makes a tab the active one in its window (onActivated). */
  activateTab(tabId: number): void;
  /** Replaces a tab with a new id (prerender/discard swap): onReplaced(added, removed). */
  replaceTab(tabId: number): Tab;
  focusWindow(windowId: number): void;
  /** Per-tab badge text, falling back to the global text, as Chrome shows it. */
  badgeText(tabId?: number): string;
  badgeColor(): string | undefined;
  /** Fires alarms.onAlarm for a created alarm, as if its time came. */
  fireAlarm(name: string): void;
  alarms(): Alarm[];
  fireInstalled(reason?: `${chrome.runtime.OnInstalledReason}`): void;
  fireStartup(): void;
  /**
   * Simulates a browser restart: every tab and window gets a new id, numbered from 1 again in the
   * same order (so old and new ids collide), storage.session is cleared, badges reset. No tab events fire.
   */
  restartBrowser(): void;
  /** Grants or revokes an optional permission (all are denied by default). */
  setPermission(name: string, granted: boolean): void;
  /** Live copies of every native tab group. */
  tabGroups(): chrome.tabGroups.TabGroup[];
  /** Sends a runtime message as the extension's own page (or `sender`) and resolves the reply. */
  sendMessage(message: unknown, sender?: Partial<chrome.runtime.MessageSender>): Promise<unknown>;
  /** Messages the extension sent with chrome.runtime.sendMessage (e.g. the worker's "changed" broadcasts). */
  broadcasts(): unknown[];
  /** Call counts of the tab-group APIs (to assert "never called"). */
  calls: { group: number; ungroup: number; update: number };
  uninstall(): void;
}

export interface MockStorageArea {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}
type StorageChanges = Record<string, chrome.storage.StorageChange>;
/** A storage area; `emit` receives the changes of each set/remove (Chrome fires onChanged for them). */
function storageArea(data: Map<string, unknown>, emit: (changes: StorageChanges) => void = () => undefined): MockStorageArea {
  return {
    async get(keys) {
      const ks = keys == null ? [...data.keys()] : typeof keys === 'string' ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const k of ks) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items) {
      const changes: StorageChanges = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: structuredClone(data.get(k)), newValue: structuredClone(v) };
        data.set(k, structuredClone(v));
      }
      if (Object.keys(changes).length) emit(changes);
    },
    async remove(keys) {
      const changes: StorageChanges = {};
      for (const k of typeof keys === 'string' ? [keys] : keys) {
        if (data.has(k)) changes[k] = { oldValue: structuredClone(data.get(k)) };
        data.delete(k);
      }
      if (Object.keys(changes).length) emit(changes);
    },
  };
}
export interface MockChrome {
  runtime: {
    id: string;
    getURL(path: string): string;
    onInstalled: MockEvent<(d: chrome.runtime.InstalledDetails) => void>;
    onStartup: MockEvent<() => void>;
    onMessage: MockEvent<
      (m: unknown, s: chrome.runtime.MessageSender, respond: (r?: unknown) => void) => boolean | void
    >;
    /** A message sent by the extension itself (the worker's broadcasts): recorded, never delivered back. */
    sendMessage(message: unknown): Promise<unknown>;
  };
  permissions: { contains(p: chrome.permissions.Permissions): Promise<boolean> };
  tabGroups: {
    query(q: chrome.tabGroups.QueryInfo): Promise<chrome.tabGroups.TabGroup[]>;
    update(id: number, p: chrome.tabGroups.UpdateProperties): Promise<chrome.tabGroups.TabGroup>;
  };
  tabs: {
    group(o: chrome.tabs.GroupOptions): Promise<number>;
    query(q: chrome.tabs.QueryInfo): Promise<Tab[]>;
    get(tabId: number): Promise<Tab>;
    /** Rejects for a missing tab or the active tab of a window (Chrome does not discard those). */
    discard(tabId: number): Promise<Tab>;
    /** Rejects when any tab id is missing. */
    remove(tabIds: number | number[]): Promise<void>;
    /** Rejects for an unknown windowId. Without one the first window is used. */
    create(p: chrome.tabs.CreateProperties): Promise<Tab>;
    update(tabId: number, p: chrome.tabs.UpdateProperties): Promise<Tab>;
    onCreated: MockEvent<(tab: Tab) => void>;
    onUpdated: MockEvent<(tabId: number, info: chrome.tabs.OnUpdatedInfo, tab: Tab) => void>;
    onRemoved: MockEvent<(tabId: number, info: chrome.tabs.OnRemovedInfo) => void>;
    onActivated: MockEvent<(info: chrome.tabs.OnActivatedInfo) => void>;
    onReplaced: MockEvent<(addedTabId: number, removedTabId: number) => void>;
  };
  windows: {
    WINDOW_ID_NONE: -1;
    update(windowId: number, p: chrome.windows.UpdateInfo): Promise<unknown>;
    /** Opens a window holding one tab per url (the first one active); without a url it holds one new-tab page. */
    create(p?: chrome.windows.CreateData): Promise<{ id: number; tabs: Tab[] }>;
    onRemoved: MockEvent<(windowId: number) => void>;
    onFocusChanged: MockEvent<(windowId: number) => void>;
  };
  action: {
    setBadgeText(d: chrome.action.BadgeTextDetails): Promise<void>;
    getBadgeText(d: { tabId?: number }): Promise<string>;
    setBadgeBackgroundColor(d: chrome.action.BadgeColorDetails): Promise<void>;
  };
  alarms: {
    create(name: string, info: chrome.alarms.AlarmCreateInfo): Promise<void>;
    get(name: string): Promise<Alarm | undefined>;
    getAll(): Promise<Alarm[]>;
    clear(name: string): Promise<boolean>;
    onAlarm: MockEvent<(alarm: Alarm) => void>;
  };
  storage: {
    local: MockStorageArea;
    /** Cleared by `restartBrowser()`, as Chrome clears it when the browser restarts. */
    session: MockStorageArea;
    /** The browser-account synced area (only this fake device; no quota is modelled). */
    sync: MockStorageArea;
    onChanged: MockEvent<(changes: StorageChanges, areaName: string) => void>;
  };
}

const clone = <T>(v: T): T => structuredClone(v);

export function installChromeMock(seed?: MockSeed): ChromeMockControl {
  let nextTabId = 1;
  let nextWindowId = 1;
  const windows: number[] = [];
  const tabs = new Map<number, Tab>(); // insertion order; index is recomputed per window
  let focused: number = -1;
  const badges = new Map<number, string>();
  let globalBadge = '';
  let badgeColor: string | undefined;
  const alarms = new Map<string, Alarm>();
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const sync = new Map<string, unknown>();
  const onStorageChanged = new MockEvent<(changes: StorageChanges, areaName: string) => void>();
  const area = (data: Map<string, unknown>, name: string) =>
    storageArea(data, (changes) => onStorageChanged.fire(changes, name));
  const granted = new Set<string>();
  const broadcasts: unknown[] = [];
  const groups = new Map<number, chrome.tabGroups.TabGroup>();
  let nextGroupId = 1;
  const calls = { group: 0, ungroup: 0, update: 0 };

  const inWindow = (w: number) => [...tabs.values()].filter((t) => t.windowId === w);
  const reindex = (w: number) => inWindow(w).forEach((t, i) => (t.index = i));
  const ordered = () => windows.flatMap(inWindow);
  const mustGet = (id: number) => {
    const t = tabs.get(id);
    if (!t) throw new Error(`No tab with id: ${id}.`);
    return t;
  };

  const mock: MockChrome = {
    runtime: {
      id: 'mock-extension-id',
      getURL: (p) => `chrome-extension://mock-extension-id/${p.replace(/^\//, '')}`,
      onInstalled: new MockEvent(),
      onStartup: new MockEvent(),
      onMessage: new MockEvent(),
      async sendMessage(message) {
        broadcasts.push(clone(message));
        return undefined;
      },
    },
    permissions: {
      async contains(p) {
        return (p.permissions ?? []).every((x) => granted.has(x));
      },
    },
    tabGroups: {
      async query(q) {
        return [...groups.values()]
          .filter((g) => (q.windowId === undefined || q.windowId === g.windowId) &&
            (q.title === undefined || q.title === g.title))
          .map(clone);
      },
      async update(id, p) {
        calls.update++;
        const g = groups.get(id);
        if (!g) throw new Error(`No group with id: ${id}.`);
        Object.assign(g, p);
        return clone(g);
      },
    },
    tabs: {
      async group(o) {
        calls.group++;
        const ids = Array.isArray(o.tabIds) ? o.tabIds : [o.tabIds];
        if (!ids.length) throw new Error('No tabIds');
        let gid = o.groupId;
        const first = mustGet(ids[0]!);
        if (gid === undefined) {
          gid = nextGroupId++;
          groups.set(gid, {
            id: gid, collapsed: false, color: 'grey', title: '', shared: false,
            windowId: o.createProperties?.windowId ?? first.windowId,
          });
        } else if (!groups.has(gid)) throw new Error(`No group with id: ${gid}.`);
        for (const id of ids) mustGet(id).groupId = gid;
        for (const k of [...groups.keys()]) if (![...tabs.values()].some((t) => t.groupId === k)) groups.delete(k);
        return gid;
      },
      async query(q) {
        return ordered()
          .filter((t) => {
            if (q.windowId !== undefined && q.windowId !== t.windowId) return false;
            if ((q.currentWindow || q.lastFocusedWindow) && t.windowId !== focused) return false;
            if (q.active !== undefined && q.active !== t.active) return false;
            if (q.pinned !== undefined && q.pinned !== t.pinned) return false;
            if (q.audible !== undefined && q.audible !== Boolean(t.audible)) return false;
            if (q.discarded !== undefined && q.discarded !== t.discarded) return false;
            if (q.status !== undefined && q.status !== t.status) return false;
            return true;
          })
          .map(clone);
      },
      async get(id) {
        return clone(mustGet(id));
      },
      async discard(id) {
        const t = mustGet(id);
        if (t.active) throw new Error(`Cannot discard the active tab with id: ${id}.`);
        if (!t.discarded) control.updateTab(id, { discarded: true });
        return clone(t);
      },
      async remove(ids) {
        const list = Array.isArray(ids) ? ids : [ids];
        list.forEach(mustGet);
        for (const id of list) removeTab(id);
      },
      async create(p) {
        if (p.windowId !== undefined && !windows.includes(p.windowId)) {
          throw new Error(`No window with id: ${p.windowId}.`);
        }
        const tab = addTab({
          url: p.url ?? 'chrome://newtab/', pinned: p.pinned ?? false, active: p.active ?? true,
          ...(p.windowId !== undefined ? { windowId: p.windowId } : {}),
        });
        return tab;
      },
      async update(id, p) {
        const t = mustGet(id);
        if (p.url !== undefined) control.updateTab(id, { url: p.url });
        if (p.pinned !== undefined) control.updateTab(id, { pinned: p.pinned });
        if (p.active) control.activateTab(id);
        return clone(t);
      },
      onCreated: new MockEvent(),
      onUpdated: new MockEvent(),
      onRemoved: new MockEvent(),
      onActivated: new MockEvent(),
      onReplaced: new MockEvent(),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      async update(windowId, p) {
        if (!windows.includes(windowId)) throw new Error(`No window with id: ${windowId}.`);
        if (p.focused) control.focusWindow(windowId);
        return { id: windowId };
      },
      async create(p) {
        const urls = p?.url === undefined ? ['chrome://newtab/'] : Array.isArray(p.url) ? p.url : [p.url];
        const id = addWindow();
        const created = urls.map((url, k) => addTab({ url, windowId: id, active: k === 0 }));
        if (p?.focused) control.focusWindow(id);
        return { id, tabs: created };
      },
      onRemoved: new MockEvent(),
      onFocusChanged: new MockEvent(),
    },
    action: {
      async setBadgeText({ tabId, text }) {
        if (tabId === undefined) globalBadge = text ?? '';
        else if (tabs.has(tabId)) badges.set(tabId, text ?? '');
        else throw new Error(`No tab with id: ${tabId}.`);
      },
      async getBadgeText({ tabId }) {
        return (tabId !== undefined ? badges.get(tabId) : undefined) ?? globalBadge;
      },
      async setBadgeBackgroundColor({ color }) {
        badgeColor = typeof color === 'string' ? color : `rgba(${color.join(',')})`;
      },
    },
    alarms: {
      async create(name, info) {
        const delay = info.delayInMinutes ?? info.periodInMinutes ?? 0;
        alarms.set(name, {
          name,
          scheduledTime: info.when ?? Date.now() + delay * 60_000,
          persistAcrossSessions: info.persistAcrossSessions ?? false,
          ...(info.periodInMinutes !== undefined ? { periodInMinutes: info.periodInMinutes } : {}),
        });
      },
      async get(name) {
        const a = alarms.get(name);
        return a && clone(a);
      },
      async getAll() {
        return [...alarms.values()].map(clone);
      },
      async clear(name) {
        return alarms.delete(name);
      },
      onAlarm: new MockEvent(),
    },
    storage: {
      local: area(local, 'local'), session: area(session, 'session'), sync: area(sync, 'sync'), onChanged: onStorageChanged,
    },
  };
  function addWindow(): number {
    const id = nextWindowId++;
    windows.push(id);
    if (focused === -1) focused = id;
    return id;
  }

  function makeTab(p: Partial<Tab>, windowId: number): Tab {
    const id = p.id ?? nextTabId++;
    nextTabId = Math.max(nextTabId, id + 1);
    return {
      index: 0, pinned: false, highlighted: false, active: false, frozen: false, incognito: false,
      selected: false, discarded: false, autoDiscardable: true, groupId: -1, lastAccessed: Date.now(),
      status: 'complete', url: 'about:blank', title: '',
      ...p,
      id,
      windowId,
    };
  }

  function addTab(p: Partial<Tab> = {}): Tab {
    const windowId = p.windowId ?? windows[0] ?? addWindow();
    if (!windows.includes(windowId)) {
      windows.push(windowId);
      nextWindowId = Math.max(nextWindowId, windowId + 1);
    }
    const tab = makeTab(p, windowId);
    tabs.set(tab.id!, tab);
    reindex(windowId);
    if (tab.active) for (const o of inWindow(windowId)) if (o.id !== tab.id) o.active = false;
    mock.tabs.onCreated.fire(clone(tab));
    return clone(tab);
  }

  function removeTab(tabId: number, isWindowClosing = false): void {
    const t = mustGet(tabId);
    tabs.delete(tabId);
    badges.delete(tabId);
    reindex(t.windowId);
    mock.tabs.onRemoved.fire(tabId, { windowId: t.windowId, isWindowClosing });
  }

  const control: ChromeMockControl = {
    chrome: mock,
    tabs: () => ordered().map(clone),
    windowIds: () => [...windows],
    addWindow,
    removeWindow(windowId) {
      for (const t of inWindow(windowId)) removeTab(t.id!, true);
      windows.splice(windows.indexOf(windowId), 1);
      mock.windows.onRemoved.fire(windowId);
      if (focused === windowId) {
        focused = windows[0] ?? -1;
        mock.windows.onFocusChanged.fire(focused);
      }
    },
    addTab,
    removeTab: (tabId) => removeTab(tabId),
    updateTab(tabId, change) {
      const t = mustGet(tabId);
      const info: chrome.tabs.OnUpdatedInfo = {};
      for (const k of ['url', 'title', 'status', 'discarded', 'pinned', 'audible', 'favIconUrl'] as const) {
        if (change[k] !== undefined && change[k] !== t[k]) Object.assign(info, { [k]: change[k] });
      }
      Object.assign(t, change, { id: tabId, windowId: t.windowId });
      if (info.url !== undefined) badges.delete(tabId); // Chrome resets per-tab badges on navigation
      mock.tabs.onUpdated.fire(tabId, info, clone(t));
      return clone(t);
    },
    activateTab(tabId) {
      const t = mustGet(tabId);
      for (const o of inWindow(t.windowId)) o.active = o.id === tabId;
      t.lastAccessed = Date.now();
      mock.tabs.onActivated.fire({ tabId, windowId: t.windowId });
    },
    replaceTab(tabId) {
      const t = mustGet(tabId);
      const next = { ...t, id: nextTabId++ };
      const entries = [...tabs.entries()].map(([k, v]) => (k === tabId ? ([next.id, next] as const) : ([k, v] as const)));
      tabs.clear();
      for (const [k, v] of entries) tabs.set(k, v);
      badges.delete(tabId);
      mock.tabs.onReplaced.fire(next.id, tabId);
      return clone(next);
    },
    focusWindow(windowId) {
      focused = windowId;
      mock.windows.onFocusChanged.fire(windowId);
    },
    badgeText: (tabId) => (tabId !== undefined ? badges.get(tabId) : undefined) ?? globalBadge,
    badgeColor: () => badgeColor,
    fireAlarm(name) {
      const a = alarms.get(name);
      if (!a) throw new Error(`no alarm "${name}"`);
      if (a.periodInMinutes === undefined) alarms.delete(name);
      mock.alarms.onAlarm.fire(clone(a));
    },
    alarms: () => [...alarms.values()].map(clone),
    fireInstalled(reason = 'install') {
      mock.runtime.onInstalled.fire({ reason } as chrome.runtime.InstalledDetails);
    },
    fireStartup: () => mock.runtime.onStartup.fire(),
    restartBrowser() {
      const old = ordered();
      const winMap = new Map(windows.map((w, k) => [w, k + 1]));
      tabs.clear();
      badges.clear();
      session.clear();
      windows.splice(0, windows.length, ...winMap.values());
      nextWindowId = windows.length + 1;
      nextTabId = 1;
      for (const t of old) {
        const id = nextTabId++;
        tabs.set(id, { ...t, id, windowId: winMap.get(t.windowId)! });
      }
      focused = windows[0] ?? -1;
    },
    setPermission(name, on) {
      if (on) granted.add(name);
      else granted.delete(name);
    },
    tabGroups: () => [...groups.values()].map(clone),
    broadcasts: () => broadcasts.map(clone),
    calls,
    sendMessage(message, sender = {}) {
      return new Promise((resolve) => {
        const s = { id: mock.runtime.id, ...sender } as chrome.runtime.MessageSender;
        let handled = false;
        for (const l of mock.runtime.onMessage.all()) {
          if (l(message, s, resolve) === true) handled = true;
        }
        if (!handled) resolve(undefined);
      });
    },
    uninstall() {
      delete (globalThis as { chrome?: unknown }).chrome;
    },
  };

  // Seed silently: a browser that is already running when the extension loads fires no events.
  for (const w of seed?.windows ?? []) {
    const windowId = addWindow();
    for (const p of w.tabs) {
      const tab = makeTab(p, windowId);
      tabs.set(tab.id!, tab);
    }
    reindex(windowId);
    const list = inWindow(windowId);
    if (list.length && !list.some((t) => t.active)) list[0]!.active = true;
  }

  (globalThis as { chrome?: unknown }).chrome = mock as unknown as typeof chrome;
  return control;
}
