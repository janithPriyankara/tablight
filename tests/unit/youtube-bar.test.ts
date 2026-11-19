import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build script helper
import { chooseYoutubeBar, outcome, scoreBar } from '../../scripts/youtube-bar.mjs';
const installed = new Set(['programming', 'music', 'tv', 'videos']);
const opts = { threshold: 0.4, installed };
const row = (group: string, label: string | null, score: number, rule: string | null = null) => ({ group, rule, label, score });
describe('youtube bar outcome (pickGroup path for a video, no exemplars or neighbours)', () => {
  it('files the top label at min(bar, threshold), else parks in Videos', () => {
    expect(outcome(row('programming', 'programming', 0.3), 0.26, opts)).toBe('programming');
    expect(outcome(row('programming', 'programming', 0.2), 0.26, opts)).toBe('videos');
    // A bar above head.threshold acts as head.threshold.
    expect(outcome(row('programming', 'programming', 0.45), 0.9, opts)).toBe('programming');
  });
  it('never files `other` or a label without an installed group; a rule with an installed group wins', () => {
    expect(outcome(row('videos', 'other', 0.9), 0, opts)).toBe('videos');
    expect(outcome(row('hardware', 'hardware', 0.9), 0, opts)).toBe('videos');
    expect(outcome(row('tv', 'music', 0.9, 'tv'), 0.26, opts)).toBe('tv');
    expect(outcome(row('x', 'programming', 0.1), 0.26, { threshold: 0.4, installed: new Set(['programming']) })).toBeNull();
  });
});
describe('chooseYoutubeBar', () => {
  // Two topic videos at 0.20 and 0.30, a no-topic video whose top label scores 0.25, one misread at 0.12.
  const rows = [
    row('programming', 'programming', 0.2),
    row('music', 'music', 0.3),
    row('videos', 'programming', 0.25),
    row('videos', 'music', 0.12),
  ];
  it('counts hits, wrong groups and parked videos per bar', () => {
    expect(scoreBar(rows, 0.1, opts)).toEqual({ bar: 0.1, hits: 2, wrong: 2, parked: 0, n: 4 });
    expect(scoreBar(rows, 0.26, opts)).toEqual({ bar: 0.26, hits: 3, wrong: 0, parked: 1, n: 4 });
  });
  it('maximises hits, then fewer wrong, then takes the highest bar of the plateau', () => {
    // 0.13..0.20: 3 hits (both topics filed, the 0.12 one parked), 1 wrong (the 0.25 no-topic video misfiled).
    // 0.21..0.25: 2 hits, 1 wrong. 0.26..0.30: 3 hits (music filed, both no-topic videos parked), 0 wrong.
    // 0.31..0.40: 2 hits. Best: 3 hits with 0 wrong, at the top of that plateau, 0.30.
    const { best, table } = chooseYoutubeBar(rows, opts);
    expect(best).toMatchObject({ bar: 0.3, hits: 3, wrong: 0 });
    expect(table).toHaveLength(41); // 0.00..0.40
  });
  it('takes the highest bar when hits and wrong tie, and an explicit grid', () => {
    const flat = [row('videos', 'programming', 0.25)];
    expect(chooseYoutubeBar(flat, { ...opts, grid: [0.1, 0.2, 0.3, 0.35] }).best).toMatchObject({ bar: 0.35, hits: 1, wrong: 0 });
  });
});
