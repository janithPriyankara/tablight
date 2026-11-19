import { describe, expect, it } from 'vitest';
import { headTop, type Head } from '../../src/classify/assign';
import bundled from '../../src/classify/head.json';
import { pickGroup, YOUTUBE_THRESHOLD } from '../../src/classify/pick';
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
    expect(pickGroup(YT, vec(0), [group('videos')], head)).toEqual({ groupId: 'videos', want: 'hardware' });
  });
  it('leaves a normal page Unsorted but remembers the topic', () => {
    expect(pickGroup(PAGE, vec(0), [group('videos')], head)).toEqual({ groupId: null, want: 'hardware' });
  });
  it('stays Unsorted when Videos is missing too', () => {
    expect(pickGroup(YT, vec(0), [], head)).toEqual({ groupId: null, want: 'hardware' });
  });
  it('uses the group when it exists', () => {
    expect(pickGroup(YT, vec(0), [group('hardware'), group('videos')], head)).toEqual({ groupId: 'hardware', want: null });
  });
  it('wants nothing for `other`', () => {
    expect(pickGroup(PAGE, vec(9), [], head)).toEqual({ groupId: null, want: null });
  });
  it('files a YouTube video whose topic is between the YouTube bar and the threshold in that topic', () => {
    expect(pickGroup(YT, vec(0), [group('hardware'), group('videos')], MID)).toEqual({ groupId: 'hardware', want: null });
  });
  it('keeps the usual threshold for a normal page', () => {
    expect(pickGroup(PAGE, vec(0), [group('hardware'), group('videos')], MID)).toEqual({ groupId: null, want: null });
  });
  it('parks a mid-confidence YouTube topic with no group in Videos without wanting it', () => {
    expect(pickGroup(YT, vec(0), [group('videos')], MID)).toEqual({ groupId: 'videos', want: null });
    expect(pickGroup(YT, vec(0), [], MID)).toEqual({ groupId: null, want: null });
  });
  it('wants the topic of a YouTube video only at head.threshold or above', () => {
    expect(pickGroup(YT, vec(0), [group('videos')], head)).toEqual({ groupId: 'videos', want: 'hardware' });
  });
  it('parks a YouTube video below the YouTube bar in Videos with nothing wanted', () => {
    expect(pickGroup(YT, vec(0), [group('hardware'), group('videos')], LOW)).toEqual({ groupId: 'videos', want: null });
  });
  it('keeps the YouTube bar below the bundled head threshold', () => {
    expect(headTop(vec(0), MID)!.score).toBeGreaterThanOrEqual(YOUTUBE_THRESHOLD);
    expect(headTop(vec(0), LOW)!.score).toBeLessThan(YOUTUBE_THRESHOLD);
    expect(YOUTUBE_THRESHOLD).toBeLessThan(bundled.threshold);
  });
  it('lets a rule hit win', () => {
    const r = pickGroup({ url: 'https://www.netflix.com/title/123', title: 'X' }, vec(0), [group('tv'), group('videos')], head);
    expect(r).toEqual({ groupId: 'tv', want: null });
  });
  it('wants nothing when a user exemplar decides', () => {
    const taught = { ...group('mine'), exemplars: [vec(0)] };
    expect(pickGroup(PAGE, vec(0), [taught], head)).toEqual({ groupId: 'mine', want: null });
  });
});
