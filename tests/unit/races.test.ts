import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/background/db';
import { maybeSuggest, processQueue, reconcile } from '../../src/background/tab-index';
import { stash, undo } from '../../src/background/memory';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';
const DIM = 384;
let n = 0;
let db: Db;
let mock: ChromeMockControl;
function vecFor(text: string): Float32Array {
  const v = new Float32Array(DIM);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  for (let i = 0; i < DIM; i++) { h = Math.imul(h ^ i, 16777619); v[i] = ((h >>> 0) % 1000) / 1000 - 0.5; }
  return v;
}
beforeEach(async () => { db = await openDb(`races-${n++}`); });
afterEach(() => mock?.uninstall());
async function unsorted(count: number, prefix: string, base: Float32Array) {
  for (let i = 0; i < count; i++) mock.addTab({ url: `https://${prefix}.example.com/${i}`, title: `${prefix} topic ${i}` });
  await reconcile(db, await chrome.tabs.query({}));
  await processQueue(db, async (texts) => texts.map((t) => base.map((v, d) => v + vecFor(t)[d]! * 0.05)));
}
describe("races and undo (bug hunt)", () => {
  it('concurrent maybeSuggest creates one suggestion', async () => {
    mock = installChromeMock();
    await unsorted(4, 'rust', vecFor('rust-base'));
    await Promise.all([maybeSuggest(db), maybeSuggest(db)]);
    const s = (await db.groups.all()).filter((g) => g.suggested);
    expect(s).toHaveLength(1);
  });
  it('concurrent maybeSuggest with autoCreateGroups', async () => {
    mock = installChromeMock();
    await db.settings.set({ autoCreateGroups: true });
    await unsorted(4, 'rust', vecFor('rust-base'));
    await Promise.all([maybeSuggest(db), maybeSuggest(db)]);
    const g = (await db.groups.all());
    expect(g).toHaveLength(1);
  });
  it('undo of first stash deletes record that second stash merged into', async () => {
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://a.com/x', active: true }, { url: 'https://a.com/x' }, { url: 'https://b.com/' }] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const [a1, a2] = (await db.items.all()).filter((i) => i.url === 'https://a.com/x');
    const r1 = await stash(db, [a1!.id]);
    await reconcile(db, await chrome.tabs.query({}));
    await stash(db, [a2!.id]);
    await reconcile(db, await chrome.tabs.query({}));
    await undo(db, r1.token);
    await reconcile(db, await chrome.tabs.query({}));
    const tabs = mock.tabs().filter((t) => t.url === 'https://a.com/x');
    const stashed = (await db.items.all()).filter((i) => i.state === 'stashed');
    expect(tabs.length + stashed.length).toBe(2);
  });
});
describe('processQueue tail race', () => {
  it('work queued while the drain clears its alarm is left behind', async () => {
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://a.com/', title: 'A' }] }] });
    await reconcile(db, await chrome.tabs.query({}));
    const emb = async (t: string[]) => t.map(vecFor);
    let late: Promise<number> | undefined;
    const origClear = chrome.alarms.clear.bind(chrome.alarms);
    vi.spyOn(chrome.alarms, 'clear').mockImplementation(async (name?: string) => {
      if (!late) {
        mock.addTab({ url: 'https://b.com/', title: 'B' });
        await reconcile(db, await chrome.tabs.query({})); // enqueues b
        late = processQueue(db, emb);
      }
      return origClear(name as string);
    });
    await processQueue(db, emb);
    await late;
    expect(await db.queue.size()).toBe(0);
  });
});
