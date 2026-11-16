import { describe, expect, it } from 'vitest';
import {
  LESSON_KEYS, LESSON_KEY_BUDGET, MAX_LESSON_TEXT, MAX_LESSONS_PER_GROUP, decodeLessons, encodeLessons, mergeLessons,
  type LessonMap,
} from '../../src/sync/lesson-codec';
import { SYNC_BUDGET } from '../../src/sync/sync-codec';

const map = (entries: [string, [string, number][]][]): LessonMap => new Map(entries.map(([n, l]) => [n.toLowerCase(), { name: n, lessons: l }]));

describe('lesson codec', () => {
  it('round-trips through storage.sync values', () => {
    const m = map([['Work', [['Inbox — mail.google.com', 3], ['Jira board — acme.atlassian.net', 2]]], ['Lab', [['Notebook — colab', 1]]]]);
    const out = decodeLessons(encodeLessons(m));
    expect(out.get('work')!.lessons).toEqual([['Inbox — mail.google.com', 3], ['Jira board — acme.atlassian.net', 2]]);
    expect(out.get('lab')!.name).toBe('Lab');
  });

  it('is deterministic, so devices holding the same lessons write identical values (no ping-pong)', () => {
    const a = map([['Work', [['b', 2], ['a', 2], ['c', 5]]], ['Lab', [['x', 1]]]]);
    const b = map([['Lab', [['x', 1]]], ['Work', [['c', 5], ['a', 2], ['b', 2]]]]);
    expect(encodeLessons(a)).toEqual(encodeLessons(b));
  });

  it('stays within its keys and budget, keeping the newest lessons', () => {
    const many: [string, number][] = Array.from({ length: 2000 }, (_, k) => [`lesson text number ${k} `.padEnd(120, 'x'), k + 1]);
    const enc = encodeLessons(map([['Work', many]]));
    expect(Object.keys(enc).every((k) => LESSON_KEYS.includes(k))).toBe(true);
    for (const v of Object.values(enc)) expect(new TextEncoder().encode(JSON.stringify(v)).length).toBeLessThanOrEqual(LESSON_KEY_BUDGET);
    const kept = decodeLessons(enc).get('work')!.lessons;
    expect(kept.length).toBeLessThanOrEqual(MAX_LESSONS_PER_GROUP);
    expect(kept[0]![1]).toBe(2000); // newest first
    // Stash chunks + lessons + meta stay under chrome.storage.sync's 102,400-byte quota.
    expect(SYNC_BUDGET + LESSON_KEYS.length * LESSON_KEY_BUDGET + 1_000).toBeLessThan(102_400);
  });

  it('ignores anything malformed or oversized from storage', () => {
    const bad = {
      [LESSON_KEYS[0]!]: JSON.stringify([
        ['Work', [['ok', 5], [42, 1], ['t', 'x'], ['', 3], ['y'.repeat(MAX_LESSON_TEXT + 1), 2], ['neg', -1], ['inf', 1e30]]],
        [7, [['a', 1]]], ['', [['a', 1]]], ['N'.repeat(61), [['a', 1]]], ['Lab', 'nope'], 'junk',
      ]),
      [LESSON_KEYS[1]!]: '{not json',
      'v1:0': JSON.stringify([['Work', [['stash chunk, not lessons', 1]]]]),
    };
    const out = decodeLessons(bad);
    expect([...out.keys()]).toEqual(['work']);
    expect(out.get('work')!.lessons).toEqual([['ok', 5]]);
  });

  it('merges by group name (any case) and text, keeping the newest time and the cap', () => {
    const a = map([['Work', [['x', 1], ['y', 5]]]]);
    const b = map([['work', [['x', 9], ['z', 2]]], ['Lab', [['l', 1]]]]);
    const m = mergeLessons(a, b);
    expect(m.get('work')!.lessons).toEqual([['x', 9], ['y', 5], ['z', 2]]);
    expect(m.get('lab')!.lessons).toEqual([['l', 1]]);
    const big = map([['Work', Array.from({ length: 80 }, (_, k) => [`t${k}`, k] as [string, number])]]);
    expect(mergeLessons(big, new Map()).get('work')!.lessons).toHaveLength(MAX_LESSONS_PER_GROUP);
  });
});
