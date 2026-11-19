import { describe, expect, it } from 'vitest';
import type { GroupSummary, Item } from '../../src/shared/types';
import { itemsForView } from '../../src/ui/dashboard/views';

function item(id: string, p: Partial<Item> = {}): Item {
  const url = `https://example.com/${id}`;
  return {
    id, url, normUrl: url, title: id, domain: 'example.com', state: 'open', tabId: 1, windowId: 1, groupId: 'g',
    groupSource: 'auto', kind: 'read', createdAt: 1, lastActiveAt: 1, updatedAt: 1, classifiable: true, ...p,
  };
}
const ids = (items: Item[]) => items.map((i) => i.id);
const GROUPS = [{ id: 'g' }, { id: 'x' }] as GroupSummary[];

describe('default list order', () => {
  it('puts the most recently used open tab first, whatever its window', () => {
    const items = [
      item('w1-old', { windowId: 1, lastActiveAt: 10 }),
      item('w7-now', { windowId: 7, lastActiveAt: 90 }),
      item('w1-mid', { windowId: 1, lastActiveAt: 50 }),
    ];
    expect(ids(itemsForView({ kind: 'all' }, items, GROUPS))).toEqual(['w7-now', 'w1-mid', 'w1-old']);
  });

  it('lists open tabs, then paused tabs, then saved ones', () => {
    const items = [
      item('saved-new', { state: 'stashed', stashedAt: 500, lastActiveAt: 500 }),
      item('paused-recent', { state: 'sleeping', lastActiveAt: 400 }),
      item('open-old', { lastActiveAt: 5 }),
      item('saved-old', { state: 'stashed', stashedAt: 100, lastActiveAt: 600 }),
      item('paused-old', { state: 'sleeping', lastActiveAt: 1 }),
    ];
    expect(ids(itemsForView({ kind: 'all' }, items, GROUPS))).toEqual(['open-old', 'paused-recent', 'paused-old', 'saved-new', 'saved-old']);
  });

  it('puts the tab you are on in each window at the very top', () => {
    const items = [
      item('recent', { tabId: 1, lastActiveAt: 90 }),
      item('now-w2', { tabId: 2, windowId: 2, lastActiveAt: 10 }),
      item('now-w1', { tabId: 3, lastActiveAt: 50 }),
      item('older', { tabId: 4, lastActiveAt: 5 }),
    ];
    expect(ids(itemsForView({ kind: 'all' }, items, GROUPS, new Set([2, 3])))).toEqual(['now-w1', 'now-w2', 'recent', 'older']);
  });

  it('orders a group page the same way', () => {
    const items = [
      item('a', { lastActiveAt: 1, windowId: 2 }),
      item('b', { lastActiveAt: 3, windowId: 9 }),
      item('other', { groupId: 'x', lastActiveAt: 99 }),
    ];
    expect(ids(itemsForView({ kind: 'group', id: 'g' }, items, GROUPS))).toEqual(['b', 'a']);
  });
});
