import { describe, expect, it } from 'vitest';
import { describeLabel } from '../../src/classify/describe';
describe('describeLabel', () => {
  it.each([
    ['2019 South Korean television series', 'tv'],
    ['1999 film directed by someone', 'movies'],
    ['2018 television film', 'movies'],
    ['2016 video game', 'games'],
    ['American semiconductor company', 'hardware'],
    ['English rock band', 'music'],
    ['film score by Hans Zimmer', 'music'],
    ['soundtrack album by someone', 'music'],
    ['Japanese manga series', 'anime'],
    ['Japanese anime television series', 'anime'],
    ['novel by someone', 'books'],
    ['automobile model', 'cars'],
    ['association football club', 'sports'],
    ['Wikimedia disambiguation page', null],
    ['human settlement', null],
    ['American actor', null],
    ['', null],
  ])('%s -> %s', (d, l) => {
    expect(describeLabel(d)).toBe(l);
  });
  it('matches whole words only', () => {
    expect(describeLabel('filmography of nobody')).toBeNull();
    expect(describeLabel('Scottish bandit')).toBeNull();
  });
});
