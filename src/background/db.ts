import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';
import {
  DEFAULT_SETTINGS,
  type Group,
  type Item,
  type ItemState,
  type Settings,
  type Snapshot,
} from '../shared/types';
export type StoreName =
  | 'items' | 'groups' | 'embeddings' | 'queue' | 'snapshots' | 'tombstones' | 'stashBackups' | 'settings';
const MAX_STASH_BACKUPS = 3;
const SETTINGS_KEY = 'main';
interface QueueEntry { itemId: string; addedAt: number }
interface Tombstone { id: string; deletedAt: number }
interface StashBackup { takenAt: number; items: Item[] }
export interface StoreApis {
  items: {
    get(id: string): Promise<Item | undefined>;
    put(i: Item): Promise<void>;
    delete(id: string): Promise<void>;
    all(): Promise<Item[]>;
    byTabId(tabId: number): Promise<Item | undefined>;
    byNormUrl(u: string): Promise<Item[]>;
    byState(s: ItemState): Promise<Item[]>;
  };
  groups: {
    get(id: string): Promise<Group | undefined>;
    put(g: Group): Promise<void>;
    delete(id: string): Promise<void>;
    all(): Promise<Group[]>;
  };
  embeddings: {
    get(key: string): Promise<Float32Array | undefined>;
    put(key: string, v: Float32Array): Promise<void>;
  };
  queue: {
    add(itemId: string): Promise<void>;
    take(n: number): Promise<string[]>;
    remove(ids: string[]): Promise<void>;
    size(): Promise<number>;
  };
  snapshots: {
    put(s: Snapshot): Promise<void>;
    all(): Promise<Snapshot[]>;
    delete(id: string): Promise<void>;
  };
  tombstones: {
    put(t: Tombstone): Promise<void>;
    all(): Promise<Tombstone[]>;
    prune(olderThan: number): Promise<void>;
  };
  stashBackups: {
    push(items: Item[]): Promise<void>;
    all(): Promise<StashBackup[]>;
  };
  settings: {
    get(): Promise<Settings>;
    set(p: Partial<Settings>): Promise<Settings>;
  };
}
export interface Db extends StoreApis {
  tx<T, S extends StoreName>(stores: S[], fn: (t: Pick<StoreApis, S>) => Promise<T>): Promise<T>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTx = IDBPTransaction<any, any, 'readwrite'>;
type Scope = <T>(names: StoreName[], fn: (tx: AnyTx) => Promise<T>) => Promise<T>;
function buildApis(scope: Scope, nextAddedAt: () => number): StoreApis {
  const one = <T>(name: StoreName, fn: (tx: AnyTx) => Promise<T>) => scope([name], fn);
  return {
    items: {
      get: (id) => one('items', (tx) => tx.objectStore('items').get(id)),
      put: (i) => one('items', async (tx) => void (await tx.objectStore('items').put(i))),
      delete: (id) => one('items', (tx) => tx.objectStore('items').delete(id)),
      all: () => one('items', (tx) => tx.objectStore('items').getAll()),
      byTabId: (tabId) => one('items', (tx) => tx.objectStore('items').index('tabId').get(tabId)),
      byNormUrl: (u) => one('items', (tx) => tx.objectStore('items').index('normUrl').getAll(u)),
      byState: (s) => one('items', (tx) => tx.objectStore('items').index('state').getAll(s)),
    },
    groups: {
      get: (id) => one('groups', (tx) => tx.objectStore('groups').get(id)),
      put: (g) => one('groups', async (tx) => void (await tx.objectStore('groups').put(g))),
      delete: (id) => one('groups', (tx) => tx.objectStore('groups').delete(id)),
      all: () => one('groups', (tx) => tx.objectStore('groups').getAll()),
    },
    embeddings: {
      get: async (key) => {
        const v: unknown = await one('embeddings', (tx) => tx.objectStore('embeddings').get(key));
        if (v === undefined) return undefined;
        return v instanceof Float32Array ? v : new Float32Array(v as ArrayLike<number>);
      },
      put: (key, v) =>
        one('embeddings', async (tx) => void (await tx.objectStore('embeddings').put(v, key))),
    },
    queue: {
      add: (itemId) =>
        one('queue', async (tx) => {
          const store = tx.objectStore('queue');
          if ((await store.getKey(itemId)) !== undefined) return;
          const entry: QueueEntry = { itemId, addedAt: nextAddedAt() };
          await store.put(entry);
        }),
      take: (n) =>
        one('queue', async (tx) => {
          const entries: QueueEntry[] = await tx.objectStore('queue').index('addedAt').getAll(undefined, n);
          return entries.map((e) => e.itemId);
        }),
      remove: (ids) =>
        one('queue', async (tx) => {
          const store = tx.objectStore('queue');
          await Promise.all(ids.map((id) => store.delete(id)));
        }),
      size: () => one('queue', (tx) => tx.objectStore('queue').count()),
    },
    snapshots: {
      put: (s) => one('snapshots', async (tx) => void (await tx.objectStore('snapshots').put(s))),
      all: () => one('snapshots', (tx) => tx.objectStore('snapshots').getAll()),
      delete: (id) => one('snapshots', (tx) => tx.objectStore('snapshots').delete(id)),
    },
    tombstones: {
      put: (t) => one('tombstones', async (tx) => void (await tx.objectStore('tombstones').put(t))),
      all: () => one('tombstones', (tx) => tx.objectStore('tombstones').getAll()),
      prune: (olderThan) =>
        one('tombstones', async (tx) => {
          const store = tx.objectStore('tombstones');
          const old: Tombstone[] = await store.index('deletedAt').getAll(IDBKeyRange.upperBound(olderThan, true));
          await Promise.all(old.map((t) => store.delete(t.id)));
        }),
    },
    stashBackups: {
      push: (items) =>
        one('stashBackups', async (tx) => {
          const store = tx.objectStore('stashBackups');
          const backup: StashBackup = { takenAt: Date.now(), items };
          await store.add(backup);
          const keys = await store.getAllKeys(); // ascending auto-increment order
          await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_STASH_BACKUPS)).map((k) => store.delete(k)));
        }),
      all: () =>
        one('stashBackups', async (tx) => {
          const all: StashBackup[] = await tx.objectStore('stashBackups').getAll();
          return all.reverse();
        }),
    },
    settings: {
      get: () => one('settings', (tx) => readSettings(tx)),
      set: (p) =>
        one('settings', async (tx) => {
          const next = { ...(await readSettings(tx)), ...p };
          await tx.objectStore('settings').put(next, SETTINGS_KEY);
          return next;
        }),
    },
  };
}
async function readSettings(tx: AnyTx): Promise<Settings> {
  const stored: Partial<Settings> | undefined = await tx.objectStore('settings').get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...stored };
}
export async function openDb(name = 'tab-organizer'): Promise<Db> {
  const idb: IDBPDatabase = await openDB(name, 1, {
    upgrade(d) {
      const items = d.createObjectStore('items', { keyPath: 'id' });
      items.createIndex('tabId', 'tabId');
      items.createIndex('normUrl', 'normUrl');
      items.createIndex('state', 'state');
      d.createObjectStore('groups', { keyPath: 'id' });
      d.createObjectStore('embeddings');
      d.createObjectStore('queue', { keyPath: 'itemId' }).createIndex('addedAt', 'addedAt');
      d.createObjectStore('snapshots', { keyPath: 'id' });
      d.createObjectStore('tombstones', { keyPath: 'id' }).createIndex('deletedAt', 'deletedAt');
      d.createObjectStore('stashBackups', { autoIncrement: true });
      d.createObjectStore('settings');
    },
  });
  let lastAddedAt = 0;
  const nextAddedAt = () => (lastAddedAt = Math.max(Date.now(), lastAddedAt + 1));
  // Each standalone call runs in its own short transaction.
  const standalone: Scope = async (names, fn) => {
    const tx = idb.transaction(names, 'readwrite');
    const result = await fn(tx as AnyTx);
    await tx.done;
    return result;
  };
  return {
    ...buildApis(standalone, nextAddedAt),
    async tx<T, S extends StoreName>(stores: S[], fn: (t: Pick<StoreApis, S>) => Promise<T>): Promise<T> {
      const tx = idb.transaction(stores, 'readwrite') as AnyTx;
      const scoped = buildApis((_names, f) => f(tx), nextAddedAt);
      try {
        const result = await fn(scoped);
        await tx.done;
        return result;
      } catch (err) {
        try { tx.abort(); } catch { /* already finished */ }
        await tx.done.catch(() => undefined);
        throw err;
      }
    },
  };
}
