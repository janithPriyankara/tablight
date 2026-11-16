import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
/** A deterministic 4-d "embedding" per text, so devices agree on vectors as the real bundled model does. */
const vec = (t: string) => {
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  return Float32Array.from([1, ((h >>> 0) % 97) / 97, ((h >>> 8) % 89) / 89, ((h >>> 16) % 83) / 83]);
};
const embedCalls: string[][] = [];
vi.mock('../../src/background/embedder', () => ({
  embed: vi.fn(async (texts: string[]) => {
    embedCalls.push(texts);
    return texts.map(vec);
  }),
}));
import { openDb, type Db } from '../../src/background/db';
import { pullSync, pushSync } from '../../src/background/sync';
import { embeddingKey } from '../../src/background/tab-index';
import { moveItems } from '../../src/background/groups';
import { LESSON_KEYS } from '../../src/sync/lesson-codec';
import { embedText } from '../../src/shared/url';
import type { Group, Item } from '../../src/shared/types';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';
let n = 0;
let A: Db;
let B: Db;
let mock: ChromeMockControl;
beforeEach(async () => {
  A = await openDb(`ls-a-${n++}`);
  B = await openDb(`ls-b-${n++}`);
  mock = installChromeMock({ windows: [] });
  embedCalls.length = 0;
});
afterEach(() => mock.uninstall());
const group = (id: string, name: string): Group => ({ id, name, color: '#000', icon: '📁', builtIn: false, exemplars: [], centroid: null, createdAt: 1 });
async function openTab(db: Db, url: string, title: string): Promise<Item> {
  const it: Item = {
    id: crypto.randomUUID(), url, normUrl: url, title, domain: new URL(url).hostname, state: 'open', tabId: 1, windowId: 1,
    groupId: null, groupSource: 'auto', kind: 'read', createdAt: 1, lastActiveAt: 1, updatedAt: 1, classifiable: true,
  };
  await db.items.put(it);
  await db.embeddings.put(await embeddingKey(it), vec(embedText(it)));
  return it;
}
describe('lesson sync', () => {
  it('a tab taught to "Lab" on one device teaches "Lab" on the other (same text, same model)', async () => {
    await A.groups.put(group('ga', 'Lab'));
    await B.groups.put(group('gb', 'lab')); // matched by name, any case
    const t = await openTab(A, 'https://colab.research.google.com/drive/abc', 'Training notebook');
    await moveItems(A, [t.id], 'ga');
    await pushSync(A);
    await pullSync(B);
    const g = (await B.groups.get('gb'))!;
    expect(g.lessons?.map(([text]) => text)).toEqual([embedText(t)]);
    expect(g.exemplars).toHaveLength(1);
    expect(g.exemplars[0]).toEqual(Array.from(vec(embedText(t))));
  });
  it('settles: once both devices hold the same lessons, further passes write nothing', async () => {
    await A.groups.put(group('ga', 'Lab'));
    await B.groups.put(group('gb', 'Lab'));
    await moveItems(A, [(await openTab(A, 'https://a.example/1', 'One')).id], 'ga');
    await moveItems(B, [(await openTab(B, 'https://b.example/2', 'Two')).id], 'gb');
    for (let k = 0; k < 3; k++) for (const d of [A, B]) await pushSync(d);
    let writes = 0;
    const set = chrome.storage.sync.set.bind(chrome.storage.sync);
    vi.spyOn(chrome.storage.sync, 'set').mockImplementation((v: Record<string, unknown>) => { writes++; return set(v); });
    for (let k = 0; k < 3; k++) for (const d of [A, B]) await pullSync(d);
    expect(writes).toBe(0);
    for (const [d, id] of [[A, 'ga'], [B, 'gb']] as const) expect((await d.groups.get(id))!.lessons).toHaveLength(2);
  });
  it('keeps another device’s lessons for a group this device doesn’t have, and never creates that group', async () => {
    await A.groups.put(group('ga', 'Lab'));
    await moveItems(A, [(await openTab(A, 'https://a.example/1', 'One')).id], 'ga');
    await pushSync(A);
    await pullSync(B); // B has no "Lab"
    expect((await B.groups.all()).some((g) => g.name === 'Lab')).toBe(false);
    await pushSync(B);
    const raw = await chrome.storage.sync.get(LESSON_KEYS);
    expect(JSON.stringify(raw)).toContain('One');
    // Later B makes a "Lab" group: the waiting lesson applies on the next pass.
    await B.groups.put(group('gb', 'Lab'));
    await pullSync(B);
    expect((await B.groups.get('gb'))!.lessons).toHaveLength(1);
  });
  it('a tab with a very long title still syncs as a lesson, and the devices settle', async () => {
    await A.groups.put(group('ga', 'Lab'));
    await B.groups.put(group('gb', 'Lab'));
    const long = await openTab(A, 'https://news.example/a/very/long/path/words/here', 'Headline '.repeat(35));
    await moveItems(A, [long.id], 'ga');
    for (let k = 0; k < 2; k++) for (const d of [A, B]) await pullSync(d);
    expect((await B.groups.get('gb'))!.lessons).toHaveLength(1);
    let writes = 0;
    const set = chrome.storage.sync.set.bind(chrome.storage.sync);
    vi.spyOn(chrome.storage.sync, 'set').mockImplementation((v: Record<string, unknown>) => { writes++; return set(v); });
    const remove = vi.spyOn(chrome.storage.sync, 'remove');
    for (let k = 0; k < 3; k++) for (const d of [A, B]) await pullSync(d);
    expect(writes).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });
  it('with sync off, no lesson is written', async () => {
    await A.groups.put(group('ga', 'Lab'));
    await A.settings.set({ syncEnabled: false });
    await moveItems(A, [(await openTab(A, 'https://a.example/1', 'One')).id], 'ga');
    await pushSync(A);
    expect(Object.keys(await chrome.storage.sync.get(LESSON_KEYS))).toEqual([]);
  });
});
