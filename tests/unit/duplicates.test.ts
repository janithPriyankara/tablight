import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/background/db';
import { BADGE_ALERT_COLOR, BADGE_COLOR, findDuplicates, invalidateBadges, resetBadgeCache, updateBadge } from '../../src/background/duplicates';
import { reconcile } from '../../src/background/tab-index';
import type { Item } from '../../src/shared/types';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';

let n = 0;
let db: Db;
let mock: ChromeMockControl | undefined;
beforeEach(async () => {
  db = await openDb(`dups-${n++}`);
  resetBadgeCache();
});
afterEach(() => {
  mock?.uninstall();
  mock = undefined;
});

function item(id: string, url: string, normUrl: string, over: Partial<Item> = {}): Item {
  return {
    id, url, normUrl, title: id, domain: '', state: 'open', tabId: Number(id.replace(/\D/g, '')) || 1, windowId: 1,
    groupId: null, groupSource: 'auto', kind: 'read', createdAt: 1, lastActiveAt: 1, updatedAt: 1, classifiable: true,
    ...over,
  };
}

describe('findDuplicates', () => {
  it('groups tracking/www/trailing-slash variants by normUrl', async () => {
    mock = installChromeMock({
      windows: [{ tabs: [{ url: 'https://a.com/x?utm_source=1' }, { url: 'https://www.a.com/x/' }, { url: 'https://b.com/' }] }],
    });
    await reconcile(db, await chrome.tabs.query({}));
    const dups = findDuplicates(await db.items.all());
    expect([...dups.keys()]).toEqual(['https://a.com/x']);
    expect(dups.get('https://a.com/x')).toHaveLength(2);
  });

  it('ignores stashed and non-web items', () => {
    const items = [
      item('i1', 'https://a.com', 'https://a.com'),
      item('i2', 'https://a.com', 'https://a.com', { state: 'stashed', tabId: undefined }),
      item('i3', 'chrome://newtab', 'chrome://newtab', { classifiable: false }),
      item('i4', 'chrome://newtab', 'chrome://newtab', { classifiable: false }),
      item('i5', 'https://c.com', 'https://c.com', { state: 'sleeping' }),
      item('i6', 'https://c.com', 'https://c.com'),
    ];
    const dups = findDuplicates(items);
    expect([...dups.keys()]).toEqual(['https://c.com']);
  });
});

describe('updateBadge', () => {
  it("shows '2×' on duplicate tabs and '' otherwise", async () => {
    mock = installChromeMock({
      windows: [
        { tabs: [{ url: 'https://a.com/x?utm_source=1', active: true }, { url: 'https://b.com/' }] },
        { tabs: [{ url: 'https://www.a.com/x/' }, { url: 'chrome://newtab' }, { url: 'chrome://newtab' }] },
      ],
    });
    await reconcile(db, await chrome.tabs.query({}));
    const [a1, b, a2, nt1, nt2] = mock.tabs();
    await updateBadge(db, a1!.id);
    expect(mock.badgeText(a1!.id)).toBe('2×');
    await updateBadge(db);
    expect(mock.badgeText(a2!.id)).toBe('2×');
    expect(mock.badgeText(b!.id)).toBe('');
    expect(mock.badgeText(nt1!.id)).toBe('');
    expect(mock.badgeText(nt2!.id)).toBe('');
    expect(mock.badgeColor()).toBeDefined();

    mock.removeTab(a2!.id!);
    await reconcile(db, await chrome.tabs.query({}));
    await updateBadge(db, a1!.id);
    expect(mock.badgeText(a1!.id)).toBe('');
  });

  it("shows '!' on every tab and the alert colour while something is suspicious, then '2×' returns", async () => {
    mock = installChromeMock({
      windows: [{ tabs: [{ url: 'https://a.com/x', active: true }, { url: 'https://a.com/x' }, { url: 'https://b.com/' }] }],
    });
    await reconcile(db, await chrome.tabs.query({}));
    const tabs = mock.tabs();
    await updateBadge(db, undefined, 2);
    for (const t of tabs) expect(mock.badgeText(t.id)).toBe('!');
    expect(mock.badgeColor()).toBe(BADGE_ALERT_COLOR);
    expect(mock.actionTitle()).toBe('Tablight: 2 suspicious tabs');
    const setColor = vi.spyOn(mock.chrome.action, 'setBadgeBackgroundColor');
    await updateBadge(db, undefined, 1);
    expect(setColor).not.toHaveBeenCalled(); // same mode: colour untouched
    expect(mock.actionTitle()).toBe('Tablight: 1 suspicious tab');
    await updateBadge(db, tabs[2]!.id, 0); // a flip with an active tab still rewrites every tab
    expect(mock.badgeText(tabs[0]!.id)).toBe('2×');
    expect(mock.badgeText(tabs[1]!.id)).toBe('2×');
    expect(mock.badgeText(tabs[2]!.id)).toBe('');
    expect(mock.badgeColor()).toBe(BADGE_COLOR);
    expect(mock.actionTitle()).toBe('Tablight');
  });
  it('recovers from alert mode after a worker restart (module state lost, Chrome keeps the badges)', async () => {
    mock = installChromeMock({
      windows: [{ tabs: [{ url: 'https://a.com/x', active: true }, { url: 'https://a.com/x' }, { url: 'https://b.com/' }] }],
    });
    await reconcile(db, await chrome.tabs.query({}));
    const tabs = mock.tabs();
    await updateBadge(db, undefined, 1);
    expect(mock.badgeText(tabs[2]!.id)).toBe('!');
    resetBadgeCache();
    await updateBadge(db, undefined, 0);
    expect(mock.badgeText(tabs[2]!.id)).toBe('');
    expect(mock.badgeText(tabs[0]!.id)).toBe('2×');
    expect(mock.badgeColor()).toBe(BADGE_COLOR);
    expect(mock.actionTitle()).toBe('Tablight');
  });
  it('a full refresh only calls setBadgeText where the text changes', async () => {
    mock = installChromeMock({
      windows: [{ tabs: [{ url: 'https://a.com/x' }, { url: 'https://a.com/x' }, { url: 'https://b.com/' }, { url: 'https://c.com/' }] }],
    });
    await reconcile(db, await chrome.tabs.query({}));
    const set = vi.spyOn(mock.chrome.action, 'setBadgeText');
    await updateBadge(db);
    expect(set).toHaveBeenCalledTimes(2); // the two duplicates; '' tabs are already ''
    set.mockClear();
    await updateBadge(db);
    expect(set).not.toHaveBeenCalled();
    const [a1, a2, b] = mock.tabs();
    mock.updateTab(b!.id!, { url: 'https://a.com/x' }); // b becomes a third copy
    await reconcile(db, await chrome.tabs.query({}));
    invalidateBadges([b!.id!]);
    await updateBadge(db);
    expect(set).toHaveBeenCalledTimes(3);
    expect([a1, a2, b].map((t) => mock!.badgeText(t!.id))).toEqual(['3×', '3×', '3×']);
  });
});
