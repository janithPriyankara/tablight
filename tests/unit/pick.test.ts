import { describe, expect, it } from 'vitest';
import type { Head } from '../../src/classify/assign';
import { pickGroup } from '../../src/classify/pick';
import type { Group } from '../../src/shared/types';
import { normalize } from '../../src/shared/vec';
const DIM = 16;
const vec = (a: number) => normalize(Array.from({ length: DIM }, (_, d) => (d === a ? 1 : 0)));
const axis = (i: number, w = 10) => Array.from({ length: DIM }, (_, d) => (d === i ? w : 0));
const head: Head = {
  model: 'test', dim: DIM, labels: ['hardware', 'other'],
  W: [axis(0), axis(9)], b: [0, 0], threshold: 0.6, similarity: 0.9,
};
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
  it('lets a rule hit win', () => {
    const r = pickGroup({ url: 'https://www.netflix.com/title/123', title: 'X' }, vec(0), [group('tv'), group('videos')], head);
    expect(r).toEqual({ groupId: 'tv', want: null });
  });
  it('wants nothing when a user exemplar decides', () => {
    const taught = { ...group('mine'), exemplars: [vec(0)] };
    expect(pickGroup(PAGE, vec(0), [taught], head)).toEqual({ groupId: 'mine', want: null });
  });
});
