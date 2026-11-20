import { afterEach, describe, expect, it } from 'vitest';
import { headTop, type Head } from '../../src/classify/assign';
import bundled from '../../src/classify/head.json';
import { currentNameIndex, parseNames, setNameIndex } from '../../src/classify/names';
import { NEIGHBOUR_POOL_MAX, pickGroup, YOUTUBE_THRESHOLD, youtubeBar, type Neighbour } from '../../src/classify/pick';
import type { Group } from '../../src/shared/types';
import { normalize } from '../../src/shared/vec';
const DIM = 16;
const vec = (a: number) => normalize(Array.from({ length: DIM }, (_, d) => (d === a ? 1 : 0)));
const axis = (i: number, w = 10) => Array.from({ length: DIM }, (_, d) => (d === i ? w : 0));
const head: Head = {
  model: 'test', dim: DIM, labels: ['hardware', 'other'],
  W: [axis(0), axis(9)], b: [0, 0], threshold: 0.6, similarity: 0.9,
};
// Five labels with a weak hardware weight: vec(0) scores hardware e^w / (e^w + 4), its top label.
const weak = (w: number): Head => ({
  ...head, labels: ['hardware', 'tv', 'music', 'news', 'other'],
  W: [axis(0, w), axis(1), axis(2), axis(3), axis(9)], b: [0, 0, 0, 0, 0],
});
const MID = weak(1); // hardware ≈ 0.40: between YOUTUBE_THRESHOLD and head.threshold (0.6)
const LOW = weak(0.1); // hardware ≈ 0.22: below YOUTUBE_THRESHOLD
const group = (id: string): Group => ({ id, name: id, color: '#000', icon: 'x', builtIn: true, exemplars: [], centroid: null, createdAt: 0 });
const YT = { url: 'https://www.youtube.com/watch?v=abc', title: 'Building a PC - YouTube' };
const PAGE = { url: 'https://example.com/pc', title: 'Building a PC' };
describe('pickGroup', () => {
  it('parks an unpicked YouTube topic in Videos and remembers the topic', () => {
    expect(pickGroup(YT, vec(0), [group('videos')], head)).toEqual({ groupId: 'videos', want: 'hardware', by: 'videos' });
  });
  it('leaves a normal page Unsorted but remembers the topic', () => {
    expect(pickGroup(PAGE, vec(0), [group('videos')], head)).toEqual({ groupId: null, want: 'hardware', by: null });
  });
  it('stays Unsorted when Videos is missing too', () => {
    expect(pickGroup(YT, vec(0), [], head)).toEqual({ groupId: null, want: 'hardware', by: null });
  });
  it('uses the group when it exists', () => {
    expect(pickGroup(YT, vec(0), [group('hardware'), group('videos')], head)).toEqual({ groupId: 'hardware', want: null, by: 'head' });
  });
  it('wants nothing for `other`', () => {
    expect(pickGroup(PAGE, vec(9), [], head)).toEqual({ groupId: null, want: null, by: null });
  });
  it('files a YouTube video whose topic is between the YouTube bar and the threshold in that topic', () => {
    expect(pickGroup(YT, vec(0), [group('hardware'), group('videos')], MID)).toEqual({ groupId: 'hardware', want: null, by: 'youtube' });
  });
  it('keeps the usual threshold for a normal page', () => {
    expect(pickGroup(PAGE, vec(0), [group('hardware'), group('videos')], MID)).toEqual({ groupId: null, want: null, by: null });
  });
  it('parks a mid-confidence YouTube topic with no group in Videos without wanting it', () => {
    expect(pickGroup(YT, vec(0), [group('videos')], MID)).toEqual({ groupId: 'videos', want: null, by: 'videos' });
    expect(pickGroup(YT, vec(0), [], MID)).toEqual({ groupId: null, want: null, by: null });
  });
  it('wants the topic of a YouTube video only at head.threshold or above', () => {
    expect(pickGroup(YT, vec(0), [group('videos')], head)).toEqual({ groupId: 'videos', want: 'hardware', by: 'videos' });
  });
  it('parks a YouTube video below the YouTube bar in Videos with nothing wanted', () => {
    expect(pickGroup(YT, vec(0), [group('hardware'), group('videos')], LOW)).toEqual({ groupId: 'videos', want: null, by: 'videos' });
  });
  it('keeps the YouTube bar below the bundled head threshold', () => {
    expect(headTop(vec(0), MID)!.score).toBeGreaterThanOrEqual(YOUTUBE_THRESHOLD);
    expect(headTop(vec(0), LOW)!.score).toBeLessThan(YOUTUBE_THRESHOLD);
  });
  it('the bundled head carries a valid YouTube bar below its threshold', () => {
    expect(bundled.youtubeThreshold).toBe(0.13);
    expect(youtubeBar(bundled)).toBe(0.13);
    expect(bundled.youtubeThreshold).toBeLessThan(bundled.threshold);
  });
  it('uses YOUTUBE_THRESHOLD when the head has no youtubeThreshold', () => {
    expect(MID.youtubeThreshold).toBeUndefined();
    expect(pickGroup(YT, vec(0), [group('hardware'), group('videos')], MID).groupId).toBe('hardware');
    expect(pickGroup(YT, vec(0), [group('hardware'), group('videos')], LOW).groupId).toBe('videos');
  });
  it("uses the head's youtubeThreshold when present, still capped at head.threshold", () => {
    const gs = [group('hardware'), group('videos')];
    // MID ≈ 0.40: a bar of 0.5 parks it, LOW ≈ 0.22: a bar of 0.2 files it.
    expect(pickGroup(YT, vec(0), gs, { ...MID, youtubeThreshold: 0.5 })).toEqual({ groupId: 'videos', want: null, by: 'videos' });
    expect(pickGroup(YT, vec(0), gs, { ...LOW, youtubeThreshold: 0.2 })).toEqual({ groupId: 'hardware', want: null, by: 'youtube' });
    // Above head.threshold (0.6) the bar is head.threshold: hardware at 0.6+ is filed by the head as before.
    expect(pickGroup(YT, vec(0), gs, { ...head, youtubeThreshold: 0.99 }).groupId).toBe('hardware');
    // Pages ignore it.
    expect(pickGroup(PAGE, vec(0), gs, { ...LOW, youtubeThreshold: 0.2 }).groupId).toBeNull();
  });
  it('falls back to YOUTUBE_THRESHOLD for a malformed youtubeThreshold', () => {
    const gs = [group('hardware'), group('videos')];
    for (const bad of [NaN, Infinity, -Infinity, -0.1, 1.5, '0.1', null, true, {}]) {
      const h = { ...MID, youtubeThreshold: bad } as unknown as Head;
      expect(youtubeBar(h), String(bad)).toBe(YOUTUBE_THRESHOLD);
      // MID ≈ 0.40 clears the fallback bar (0.26): filed, as with no youtubeThreshold at all.
      expect(pickGroup(YT, vec(0), gs, h).groupId, String(bad)).toBe('hardware');
      // LOW ≈ 0.22 is below the fallback bar: a malformed value never lowers it.
      expect(pickGroup(YT, vec(0), gs, { ...LOW, youtubeThreshold: bad } as unknown as Head).groupId, String(bad)).toBe('videos');
    }
  });
  it('accepts the edges 0 and 1 and still caps at head.threshold', () => {
    expect(youtubeBar({ threshold: 0.6, youtubeThreshold: 0 })).toBe(0);
    expect(youtubeBar({ threshold: 0.6, youtubeThreshold: 1 })).toBe(0.6);
    expect(youtubeBar({ threshold: 0.2 })).toBe(0.2);
    expect(youtubeBar({ threshold: 0.6 })).toBe(YOUTUBE_THRESHOLD);
  });
  it('lets a rule hit win', () => {
    const r = pickGroup({ url: 'https://www.netflix.com/title/123', title: 'X' }, vec(0), [group('tv'), group('videos')], head);
    expect(r).toEqual({ groupId: 'tv', want: null, by: 'rule' });
  });
  it('wants nothing when a user exemplar decides', () => {
    const taught = { ...group('mine'), exemplars: [vec(0)] };
    expect(pickGroup(PAGE, vec(0), [taught], head)).toEqual({ groupId: 'mine', want: null, by: 'exemplar' });
  });
});
describe('pickGroup name step', () => {
  afterEach(() => setNameIndex(null));
  const names = parseNames('#tv\nbreaking bad\n#movies\nfoo bar\n');
  // vec(0) reads as hardware at 0.73 with `head`: the head would file it, so a name hit shows the step runs first.
  const SEARCH = { url: 'https://www.google.com/search?q=breaking+bad', title: 'breaking bad - Google Search' };
  it('name step files a bare-name search into tv when tv exists', () => {
    setNameIndex(names);
    expect(pickGroup(SEARCH, vec(0), [group('tv'), group('hardware')], head)).toEqual({ groupId: 'tv', want: null, by: 'name' });
  });
  it('name step sets want when the group is missing', () => {
    setNameIndex(names);
    expect(pickGroup(SEARCH, vec(5), [group('hardware')], head)).toEqual({ groupId: null, want: 'tv', by: null });
    // A YouTube video's plain title is never named: it parks in Videos without a named topic.
    const yt = { url: 'https://www.youtube.com/watch?v=x', title: 'Breaking Bad - YouTube' };
    expect(pickGroup(yt, vec(5), [group('videos')], head)).toEqual({ groupId: 'videos', want: null, by: 'videos' });
    // The list never names a plain page title.
    const page = { url: 'https://example.com/bb', title: 'Breaking Bad' };
    expect(pickGroup(page, vec(5), [group('tv')], head)).toEqual({ groupId: null, want: null, by: null });
  });
  it('lets the head place a tab whose named group is missing', () => {
    setNameIndex(names);
    expect(pickGroup(SEARCH, vec(0), [group('hardware')], head)).toEqual({ groupId: 'hardware', want: null, by: 'head' });
  });
  it('exemplar beats name', () => {
    setNameIndex(names);
    const taught = { ...group('mine'), exemplars: [vec(0)] };
    expect(pickGroup(SEARCH, vec(0), [taught, group('tv')], head)).toEqual({ groupId: 'mine', want: null, by: 'exemplar' });
  });
  it('rule beats name', () => {
    setNameIndex(names);
    // The rule runs first: a rule page is decided before any name (rule hosts are never search or Wikipedia pages).
    const netflix = { url: 'https://www.netflix.com/title/123', title: 'Breaking Bad | Netflix' };
    expect(pickGroup(netflix, vec(0), [group('tv'), group('hardware')], head)).toEqual({ groupId: 'tv', want: null, by: 'rule' });
  });
  it('pickGroup without names loaded', () => {
    setNameIndex(null);
    expect(currentNameIndex()).toBeNull();
    expect(pickGroup(SEARCH, vec(0), [group('tv'), group('hardware')], head)).toEqual({ groupId: 'hardware', want: null, by: 'head' });
    expect(pickGroup(SEARCH, vec(5), [group('tv')], head)).toEqual({ groupId: null, want: null, by: null });
  });
  it('files a part number once the list is loaded, and not before', () => {
    const rtx = { url: 'https://www.google.com/search?q=rtx+4090', title: 'rtx 4090 - Google Search' };
    expect(pickGroup(rtx, vec(5), [group('hardware')], head)).toEqual({ groupId: null, want: null, by: null });
    setNameIndex(names);
    expect(pickGroup(rtx, vec(5), [group('hardware')], head)).toEqual({ groupId: 'hardware', want: null, by: 'name' });
  });
});
describe('pickGroup neighbours', () => {
  // vec(5) is unsure for `head` (hardware 0.5 < 0.6), wants nothing, and is above the YouTube bar for hardware.
  const UNSURE = vec(5);
  /** A unit vector at cosine exactly `c` to vec(to), leaning towards axis `j` (distinct j: distinct tabs). */
  const near = (c: number, j: number, to = 5) => {
    const v = new Array<number>(DIM).fill(0);
    v[to] = c;
    v[j] = Math.sqrt(1 - c * c);
    return v;
  };
  // Close: just above the head's similarity bar (0.9 for `head`), where neighbours count.
  const C = head.similarity + 0.05;
  let k = 0;
  const tab = (groupId: string, j: number, over: Partial<Neighbour> = {}): Neighbour =>
    ({ vec: near(C, j), groupId, normUrl: `https://n${k++}.example.com/`, ...over });
  const groups = [group('hardware'), group('programming'), group('videos')];
  it('leaves the pool entry with skipId out', () => {
    const pool = [tab('hardware', 1, { id: 'self' }), tab('hardware', 2, { id: 'other' })];
    expect(pickGroup(PAGE, UNSURE, groups, head, pool, 'self').by).toBeNull();
    expect(pickGroup(PAGE, UNSURE, groups, head, pool).by).toBe('neighbour');
  });
  it('follows two close tabs that agree', () => {
    expect(pickGroup(PAGE, UNSURE, groups, head, [tab('hardware', 1), tab('hardware', 2)]))
      .toEqual({ groupId: 'hardware', want: null, by: 'neighbour' });
  });
  it("uses the head's similarity as the bar", () => {
    const strict: Head = { ...head, similarity: C + 0.01 };
    expect(pickGroup(PAGE, UNSURE, groups, strict, [tab('hardware', 1), tab('hardware', 2)]).by).toBeNull();
  });
  it('needs more than one close tab', () => {
    expect(pickGroup(PAGE, UNSURE, groups, head, [tab('hardware', 1)])).toEqual({ groupId: null, want: null, by: null });
  });
  it('ignores tabs that are not close', () => {
    const far = (j: number): Neighbour => ({ ...tab('hardware', j), vec: near(head.similarity - 0.01, j) });
    expect(pickGroup(PAGE, UNSURE, groups, head, [far(1), far(2), far(3)]).by).toBeNull();
  });
  it('places nothing on a tie', () => {
    const pool = [tab('hardware', 1), tab('hardware', 2), tab('programming', 3), tab('programming', 4)];
    expect(pickGroup(PAGE, UNSURE, groups, head, pool)).toEqual({ groupId: null, want: null, by: null });
  });
  it('counts tabs of the same page once', () => {
    const pool = [tab('hardware', 1, { normUrl: 'https://same.example.com/' }), tab('hardware', 2, { normUrl: 'https://same.example.com/' })];
    expect(pickGroup(PAGE, UNSURE, groups, head, pool).by).toBeNull();
  });
  it('ignores tabs in a group that no longer exists', () => {
    const pool = [tab('gone', 1), tab('gone', 2), tab('gone', 3), tab('hardware', 4), tab('hardware', 6)];
    expect(pickGroup(PAGE, UNSURE, groups, head, pool)).toEqual({ groupId: 'hardware', want: null, by: 'neighbour' });
  });
  it('skips a vector of another length without throwing', () => {
    const short = (j: number): Neighbour => ({ ...tab('hardware', j), vec: [0, 0, 0, 0, 0, 1, 0, 0] });
    expect(pickGroup(PAGE, UNSURE, groups, head, [short(1), short(2)]).by).toBeNull();
  });
  it('never pulls a tab the head reads as `other` into a group', () => {
    // vec(9) is `other` for `head`; two close tabs in hardware agree, but only the user files such tabs.
    const nearOther = (j: number): Neighbour => ({ ...tab('hardware', j), vec: near(C, j, 9) });
    expect(pickGroup(PAGE, vec(9), groups, head, [nearOther(1), nearOther(2)])).toEqual({ groupId: null, want: null, by: null });
  });
  it('lets a confident head win over neighbours', () => {
    const sure: Head = { ...head, labels: ['hardware', 'ai', 'other'], W: [axis(0), axis(1), axis(9)], b: [0, 0, 0] };
    const nearAi = (j: number): Neighbour => ({ ...tab('hardware', j), vec: near(C, j, 1) });
    expect(pickGroup(PAGE, vec(1), [...groups, group('ai')], sure, [nearAi(2), nearAi(3)]))
      .toEqual({ groupId: 'ai', want: null, by: 'head' });
  });
  it('lets a rule and an exemplar win over neighbours', () => {
    const netflix = { url: 'https://www.netflix.com/title/123', title: 'X' };
    expect(pickGroup(netflix, UNSURE, [...groups, group('tv')], head, [tab('hardware', 1), tab('hardware', 2)]))
      .toEqual({ groupId: 'tv', want: null, by: 'rule' });
    const taught = { ...group('mine'), exemplars: [vec(5)] };
    expect(pickGroup(PAGE, UNSURE, [...groups, taught], head, [tab('hardware', 1), tab('hardware', 2)]))
      .toEqual({ groupId: 'mine', want: null, by: 'exemplar' });
  });
  it('lets neighbours place a YouTube video before the low YouTube bar', () => {
    expect(pickGroup(YT, UNSURE, groups, head).groupId).toBe('hardware'); // the YouTube bar alone
    expect(pickGroup(YT, UNSURE, groups, head, [tab('programming', 1), tab('programming', 2)]))
      .toEqual({ groupId: 'programming', want: null, by: 'neighbour' });
  });
  it(`stays fast with a pool of ${NEIGHBOUR_POOL_MAX} tabs`, () => {
    let seed = 1;
    const rand = () => ((seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32 - 0.5;
    const D = 384;
    const unit = () => normalize(Array.from({ length: D }, rand));
    const big: Head = { ...head, dim: D, W: [unit(), unit()], b: [0, 0] };
    const pool: Neighbour[] = Array.from({ length: NEIGHBOUR_POOL_MAX }, (_, i) =>
      ({ vec: Float32Array.from(unit()), groupId: i % 2 ? 'hardware' : 'programming', normUrl: `https://p${i}.example.com/` }));
    const queries = Array.from({ length: 100 }, () => Float32Array.from(unit()));
    const t0 = performance.now();
    for (const q of queries) pickGroup(PAGE, q, groups, big, pool);
    // 1500 ms, not a laptop's few hundred: the shared CI host runs 2-3x slower.
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
