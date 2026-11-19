import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/background/db';
import { createGroup, moveItems, regroupApply, regroupPreview } from '../../src/background/groups';
import { embeddingKey } from '../../src/background/tab-index';
import { EMBED_MODEL } from '../../src/classify/model';
import { sha1hex } from '../../src/shared/hash';
import { cleanTitle } from '../../src/shared/url';
import type { Group, Item } from '../../src/shared/types';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';
// Items classified under v1.3.0 keep their vector under the old key (recorded in `embKey`) until re-embedded.
// The update itself re-queues nothing, so user-placed tabs keep only that vector: it must still teach and regroup.
let n = 0;
let db: Db;
let mock: ChromeMockControl;
const group = (id: string, over: Partial<Group> = {}): Group => ({
  id, name: id, color: '#0090ff', icon: 'x', builtIn: true, exemplars: [], centroid: null, createdAt: 1, ...over,
});
/** An item whose only vector sits under the v1.3.0-form key (model + url + clean title). */
async function oldItem(id: string, over: Partial<Item> = {}, fill = 0.05): Promise<Item> {
  const url = over.url ?? `https://example.com/${id}`;
  const base: Item = {
    id, url, normUrl: url, title: 'Zelda walkthrough', domain: 'example.com', state: 'open', groupId: null,
    groupSource: 'auto', kind: 'read', createdAt: 1, lastActiveAt: 1, updatedAt: 1, classifiable: true, ...over,
  };
  const oldKey = await sha1hex(`${EMBED_MODEL}\n${url}\n${cleanTitle(base.title, url)}`);
  expect(oldKey).not.toBe(await embeddingKey(base));
  const item = { ...base, embKey: oldKey };
  await db.items.put(item);
  await db.embeddings.put(oldKey, new Float32Array(384).fill(fill));
  return item;
}
beforeEach(async () => {
  db = await openDb(`upgrade-${n++}`);
  mock = installChromeMock();
});
afterEach(() => mock.uninstall());
describe('vectors stored under a pre-upgrade key', () => {
  it('moveItems teaches the group from the old-key vector', async () => {
    await db.groups.put(group('games'));
    await oldItem('a');
    await moveItems(db, ['a'], 'games');
    expect((await db.groups.get('games'))!.exemplars).toHaveLength(1);
  });
  it('createGroup from a selection gets the old-key vector as an exemplar', async () => {
    await oldItem('a');
    const g = await createGroup(db, 'Zelda', ['a']);
    expect((await db.groups.get(g.id))!.exemplars).toHaveLength(1);
  });
  it('the current key wins when both exist', async () => {
    await db.groups.put(group('games'));
    const item = await oldItem('a');
    await db.embeddings.put(await embeddingKey(item), new Float32Array(384).fill(-0.05));
    await moveItems(db, ['a'], 'games');
    expect((await db.groups.get('games'))!.exemplars[0]![0]).toBeLessThan(0);
  });
  it('regroup includes an auto item whose vector has only the old key', async () => {
    const v = Array.from(new Float32Array(384).fill(0.05));
    await db.groups.put(group('taught', { builtIn: false, exemplars: [v], centroid: v }));
    await oldItem('a');
    expect(await regroupPreview(db)).toContainEqual({ groupId: 'taught', before: 0, after: 1 });
    expect(await regroupApply(db)).toBe(1);
    expect((await db.items.get('a'))!.groupId).toBe('taught');
  });
});
