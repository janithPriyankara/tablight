import { describe, expect, it } from 'vitest';
import { newTally, report, tally } from '../benchmark/score';
describe('benchmark scoring', () => {
  it('scores precision and coverage on non-other tabs; an `other` tab is never right', () => {
    const t = newTally();
    tally(t, { group: 'news' }, 'news'); // right
    tally(t, { group: 'news' }, 'work'); // wrong
    tally(t, { group: 'news', also: ['work'] }, 'work'); // lenient only
    tally(t, { group: 'music' }, null); // Unsorted
    tally(t, { group: 'other' }, null); // left alone: not a right
    tally(t, { group: 'other' }, null);
    tally(t, { group: 'other' }, 'news'); // pulled into a group
    expect(t).toMatchObject({ total: 4, grouped: 3, strict: 1, lenient: 2, others: 3, otherUnsorted: 2, otherGrouped: 1 });
    expect(t.perLabel.get('news')).toEqual({ n: 3, right: 1 });
    expect(t.perLabel.get('music')).toEqual({ n: 1, right: 0 });
    expect(t.perLabel.has('other')).toBe(false);
    const text = report('x', t);
    expect(text).toContain('coverage 75.0%');
    expect(text).toContain('strict:  precision 33.3% (1/3), overall 25.0% (1/4)');
    expect(text).toContain('lenient: precision 66.7% (2/3), overall 50.0% (2/4)');
    expect(text).toContain('left Unsorted 2, put in a group 1');
    expect(text).toContain('strict precision counting those as wrong 25.0%');
  });
  it('leaving every tab Unsorted scores zero, however many `other` tabs there are', () => {
    const t = newTally();
    for (let i = 0; i < 9; i++) tally(t, { group: 'other' }, null);
    tally(t, { group: 'news' }, null);
    expect(t.strict).toBe(0);
    expect(report('x', t)).toContain('overall 0.0% (0/1)');
  });
});
