import { describe, expect, it } from 'vitest';
import { addressClue, cluesFor, findSuspicious, isSuspicious, titleClue } from '../../src/background/suspicious';
import type { TabContext } from '../../src/shared/clues';
import type { Item } from '../../src/shared/types';
const CLICK = 'https://official-app.space/click?key=abc123&visitor_id=987';
function item(over: Partial<Item> = {}): Item {
  return {
    id: 'i1', url: 'https://example.com/', normUrl: 'https://example.com/', title: 'Example', domain: 'example.com',
    state: 'open', tabId: 1, windowId: 1, groupId: null, groupSource: 'auto', kind: 'read', createdAt: 1,
    lastActiveAt: 1, updatedAt: 1, classifiable: true, ...over,
  };
}
describe('addressClue', () => {
  it.each([
    CLICK,
    'http://185.23.4.10/landing',
    'https://xn--pypal-4ve.com/login',
    'https://track.example.top/redirect?clickid=x1&zoneid=55',
    'http://127.0.0.1:8080/click?key=1&visitor_id=2',
    'https://spam.xyz/page?subid=9',
  ])('flags %s', (u) => expect(addressClue(u)).toBe(true));
  it.each([
    'https://github.com/user/repo/issues?q=click',
    'https://www.google.com/search?q=deposit+bonus',
    'https://docs.python.org/3/library/',
    'https://news.ycombinator.com/item?id=1',
    'http://127.0.0.1:5173/',
    'http://192.168.1.20/admin',
    'http://localhost:3000/',
    'http://10.1.2.3/',
    'http://172.20.0.5/',
    'http://169.254.1.1/',
    'http://[::1]:8080/',
    'http://[fd12::1]/',
    'https://example.xyz/about',
  ])('does not flag %s', (u) => expect(addressClue(u)).toBe(false));
  it('flags a public 172.x address outside the private range', () => {
    expect(addressClue('http://172.32.0.1/')).toBe(true);
  });
});
describe('titleClue', () => {
  it.each([
    'Congratulations! You won an iPhone 17',
    'Open an envelope and reveal your 100% deposit bonus',
    'WARNING: Your PC is infected with 5 viruses',
    'Call Microsoft Support now',
  ])('flags %s', (t) => expect(titleClue(t)).toBe(true));
  it.each([
    'How to claim a tax deduction',
    'Bonus episode: Rust async',
    'Microsoft Support – Windows help',
    'Virus taxonomy - Wikipedia',
    "You won't believe how this works",
    'Why you won’t regret it',
  ])('does not flag %s', (t) => expect(titleClue(t)).toBe(false));
});
describe('cluesFor', () => {
  const ctx: TabContext = { openerDomain: 'news.example.com', popup: false };
  const spam = item({ url: CLICK, domain: 'official-app.space', opened: false });
  it('lists clues in order', () => {
    expect(cluesFor(spam, ctx)).toEqual(['opener', 'unseen', 'address']);
  });
  it('has no opener clue for the same domain', () => {
    expect(cluesFor(spam, { openerDomain: 'official-app.space', popup: false })).not.toContain('opener');
  });
  it('has no unseen clue when opened is undefined', () => {
    expect(cluesFor({ ...spam, opened: undefined }, ctx)).not.toContain('unseen');
  });
  it('adds popup and title', () => {
    const i = item({ title: 'You won a prize', opened: true });
    expect(cluesFor(i, { popup: true })).toEqual(['popup', 'title']);
  });
  it('works without context', () => {
    expect(cluesFor(item(), undefined)).toEqual([]);
  });
});
describe('isSuspicious', () => {
  it.each([
    [['opener', 'unseen'], false],
    [['title'], false],
    [['address'], false],
    [[], false],
    [['address', 'title'], true],
    [['unseen', 'address', 'title'], true],
    [['popup', 'title'], true],
    [['opener', 'address'], true],
  ] as const)('%j -> %s', (clues, want) => expect(isSuspicious([...clues])).toBe(want));
});
describe('findSuspicious', () => {
  const ctx = new Map<number, TabContext>([[1, { popup: true }]]);
  const bad = (over: Partial<Item> = {}) => item({ title: 'You won a prize', ...over });
  it('flags a scam tab and sorts newest first', () => {
    const a = bad({ id: 'a', tabId: 1, lastActiveAt: 5 });
    const b = bad({ id: 'b', tabId: 2, lastActiveAt: 9 });
    const out = findSuspicious([a, b], new Map([...ctx, [2, { popup: true }]]), new Map());
    expect(out.map((s) => s.item.id)).toEqual(['b', 'a']);
    expect(out[0]!.clues).toEqual(['popup', 'title']);
  });
  it('skips non-web urls', () => {
    expect(findSuspicious([bad({ url: 'chrome://settings' })], ctx, new Map())).toEqual([]);
  });
  it('skips stashed, unclassifiable and tab-less items', () => {
    expect(findSuspicious([bad({ state: 'stashed' })], ctx, new Map())).toEqual([]);
    expect(findSuspicious([bad({ classifiable: false })], ctx, new Map())).toEqual([]);
    expect(findSuspicious([bad({ tabId: undefined })], ctx, new Map())).toEqual([]);
  });
  it('skips a kept tab while its domain matches, includes it for another domain', () => {
    const i = bad();
    expect(findSuspicious([i], ctx, new Map([[1, 'example.com']]))).toEqual([]);
    expect(findSuspicious([i], ctx, new Map([[1, 'other.com']]))).toHaveLength(1);
  });
  it('drops a tab once its url and title become normal', () => {
    expect(findSuspicious([bad()], ctx, new Map())).toHaveLength(1);
    expect(findSuspicious([item()], ctx, new Map())).toEqual([]);
  });
});
