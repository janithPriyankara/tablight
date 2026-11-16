import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/background/embedder', () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(3).fill(0.05))),
}));
import { openDb, type Db } from '../../src/background/db';
import { pullSync, pushSync, setSyncEnabled } from '../../src/background/sync';
import { deleteStashed } from '../../src/background/memory';
import { processQueue } from '../../src/background/tab-index';
import { moveItems } from '../../src/background/groups';
import { deleteAllData } from '../../src/background/reset';
import { sha1hex } from '../../src/shared/hash';
import type { Group, Item } from '../../src/shared/types';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';

let n = 0;
let A: Db;
let B: Db;
let mock: ChromeMockControl;
let clock = 1_000_000;
beforeEach(async () => {
  A = await openDb(`rb-a-${n++}`);
  B = await openDb(`rb-b-${n++}`);
  mock = installChromeMock({ windows: [] });
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(() => {
  mock.uninstall();
  vi.restoreAllMocks();
});
const embedFn = async (texts: string[]) => texts.map(() => new Float32Array(3).fill(0.1)); // classify → null
async function stash(db: Db, url: string, at: number): Promise<Item> {
  const it: Item = {
    id: await sha1hex(url), url, normUrl: url, title: 'X', domain: 'x.com', state: 'stashed', groupId: null,
    groupSource: 'auto', kind: 'read', createdAt: at, lastActiveAt: at, stashedAt: at, updatedAt: at, classifiable: true,
  };
  await db.items.put(it);
  return it;
}
const work: Group = { id: 'g-work', name: 'Work', color: '#000', icon: '📁', builtIn: false, exemplars: [], centroid: null, createdAt: 1 };

describe('sync across devices (bug hunt)', () => {
  it('unsorted items ping-pong: every pull re-queues, classification re-stamps, every push rewrites', async () => {
    const x = await stash(A, 'https://x.com/', clock);
    await pushSync(A);
    const stamps: number[] = [];
    let writes = 0;
    const set = chrome.storage.sync.set.bind(chrome.storage.sync);
    vi.spyOn(chrome.storage.sync, 'set').mockImplementation((v: Record<string, unknown>) => { writes++; return set(v); });
    for (let round = 0; round < 3; round++) {
      for (const db of [B, A]) {
        clock += 10_000;
        await pullSync(db);
        await processQueue(db, embedFn);
        clock += 10_000;
        await pushSync(db);
        stamps.push((await db.items.get(x.id))!.updatedAt);
      }
    }
    expect((await A.items.get(x.id))!.groupId).toBeNull(); // nothing ever changed semantically
    expect(writes).toBe(0);
  });

  it('a user group move on B is undone by A re-classifying the pulled record a moment later', async () => {
    await B.groups.put(work);
    const x = await stash(B, 'https://x.com/', clock);
    await pushSync(B); // B stashed X
    clock += 1000;
    await pullSync(A); // A pulls X → queued for classification
    clock += 1000;
    await moveItems(B, [x.id], work.id); // user files X under Work on B
    clock += 1000;
    await processQueue(A, embedFn); // A's classifier finishes: re-stamps X (still unsorted)
    clock += 1000;
    await pushSync(B); // B's debounced push (Work)
    clock += 1000;
    await pullSync(A); // A: its local stamp is newer → keeps & pushes unsorted
    clock += 1000;
    await pullSync(B);
    expect((await B.items.get(x.id))!.groupId).toBe(work.id);
  });

  it('Delete all data: the stash comes straight back from another device', async () => {
    const x = await stash(A, 'https://x.com/', clock);
    await pushSync(A);
    clock += 1000;
    await pullSync(B);
    clock += 1000;
    await deleteAllData(A);
    expect(await A.items.get(x.id)).toBeUndefined();
    clock += 1000;
    await pullSync(B); // B's onChanged for the removed v1:* keys
    clock += 1000;
    await pullSync(A); // A's onChanged for B's write
    expect(await A.items.get(x.id)).toBeUndefined();
  });

  it('a delete made while sync was off resurrects when sync is turned back on after 30 days', async () => {
    const x = await stash(A, 'https://x.com/', clock);
    await pushSync(A);
    await setSyncEnabled(A, false);
    clock += 1000;
    await deleteStashed(A, [x.id]);
    expect(await A.tombstones.get(x.id)).toBeDefined();
    clock += 31 * 86_400_000;
    await setSyncEnabled(A, true);
    expect(await A.items.get(x.id)).toBeUndefined();
  });
});
describe('hostile sync data (devices)', () => {
  it('groups created from synced names are capped in total, not per pass', async () => {
    const { MAX_GROUPS_FROM_SYNC } = await import('../../src/background/sync');
    for (let k = 0; k < MAX_GROUPS_FROM_SYNC + 30; k++) {
      const url = `https://x.com/${k}`;
      await B.items.put({
        id: await sha1hex(url), url, normUrl: url, title: 'X', domain: 'x.com', state: 'stashed', groupId: `g${k}`,
        groupSource: 'user', kind: 'read', createdAt: 1, lastActiveAt: 1, stashedAt: 1, updatedAt: clock, classifiable: true,
      });
      await B.groups.put({ id: `g${k}`, name: `Spam ${k}`, color: '#000', icon: '📁', builtIn: false, exemplars: [], centroid: null, createdAt: 1 });
    }
    await pushSync(B);
    for (let pass = 0; pass < 5; pass++) {
      clock += 1000;
      await pullSync(A);
    }
    const made = (await A.groups.all()).filter((g) => g.name.startsWith('Spam'));
    expect(made.length).toBeLessThanOrEqual(MAX_GROUPS_FROM_SYNC);
  });
});
