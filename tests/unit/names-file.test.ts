import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normName } from '../../src/classify/names';
import { STARTER_GROUPS } from '../../src/classify/seeds';
// @ts-expect-error: plain .mjs build script without types; only its pure normName mirror is imported.
import { normName as scriptNormName } from '../../scripts/names/norm.mjs';

const root = resolve(import.meta.dirname, '../..');
const FILE = resolve(root, 'public/names/names.txt');
const LIMIT = 1_500_000;

/** Section label -> names, in file order; every line kept as written (no trimming) so the test sees the raw file. */
function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('#')) {
      const label = line.slice(1);
      cur = out.get(label) ?? [];
      out.set(label, cur);
    } else {
      if (!cur) throw new Error('a name appears before the first #label line');
      cur.push(line);
    }
  }
  return out;
}

describe('public/names/names.txt', () => {
  it('exists and is within the size cap', () => {
    expect(statSync(FILE).size).toBeLessThanOrEqual(LIMIT);
  });
  const text = (() => {
    try {
      return readFileSync(FILE, 'utf8');
    } catch {
      return '';
    }
  })();
  const secs = sections(text);
  const ids = new Set(STARTER_GROUPS.map((g) => g.id));
  it('uses only starter group ids as section labels, each once (people of music and sports in their own)', () => {
    expect(secs.size).toBeGreaterThan(0);
    for (const label of secs.keys()) {
      const base = label.replace(/\.person$/, '');
      expect(ids.has(base), `unknown label ${label}`).toBe(true);
      if (base !== label) expect(['music', 'sports'], `people under ${label}`).toContain(base);
    }
    const headers = text.split('\n').filter((l) => l.startsWith('#'));
    expect(new Set(headers).size).toBe(headers.length);
  });
  it('holds only normalized names of 4+ characters, none in two sections', () => {
    const seen = new Map<string, string>();
    let bad = 0;
    let short = 0;
    let dup = 0;
    for (const [label, names] of secs) {
      for (const n of names) {
        if (normName(n) !== n) bad++;
        if (n.length < 4) short++;
        if (seen.has(n)) dup++;
        seen.set(n, label);
      }
    }
    expect({ bad, short, dup }).toEqual({ bad: 0, short: 0, dup: 0 });
    expect(seen.size).toBeGreaterThan(1000);
  });
  it('leaves out ordinary words', () => {
    const all = new Set([...secs.values()].flat());
    for (const w of ['friends', 'up', 'her', 'cars', 'home', 'news', 'games', 'music']) expect(all.has(w), w).toBe(false);
  });
  // Regressions from the Task 3 review: writers filed as musicians, places and holidays claimed by a bracketed
  // article's bare title, ordinary full names among athletes, "the" + an everyday word.
  it('leaves out names that belong to something else or to many people', () => {
    const all = new Set([...secs.values()].flat());
    const probes = [
      'leonardo da vinci', 'dan brown', 'douglas adams', 'thomas mann',
      'new york', 'san francisco', 'las vegas', 'american football', 'groundhog day', 'pearl harbor', 'mona lisa',
      'michael collins', 'robert bosch',
      'giuseppe rossi', 'masaaki kato', 'mitsuo watanabe', 'cristian rodriguez',
      'the music', 'the cars', 'the streets',
      'dada',
    ];
    expect(probes.filter((w) => all.has(w))).toEqual([]);
  });
  it('files people in the person sections', () => {
    expect(secs.get('sports.person') ?? []).toEqual(expect.arrayContaining(['lionel messi', 'david silva']));
    expect(secs.get('music.person') ?? []).toEqual(expect.arrayContaining(['bob dylan']));
    expect(secs.get('sports') ?? []).not.toContain('lionel messi');
    expect(secs.get('music') ?? []).toEqual(expect.arrayContaining(['metallica']));
    expect(secs.get('music.person') ?? []).not.toContain('metallica');
  });
  it('still holds well-known names', () => {
    const all = new Set([...secs.values()].flat());
    const probes = ['breaking bad', 'the shawshank redemption', 'metallica', 'lionel messi', 'bob dylan', 'elden ring'];
    expect(probes.filter((w) => !all.has(w))).toEqual([]);
  });
});

describe('scripts/names/norm.mjs', () => {
  const samples = [
    'Amélie', 'Pokémon Scarlet & Violet', 'Beyoncé', 'Mötley Crüe', 'Sigur Rós', 'Björk', 'Ñandú', 'Øresund', 'Straße',
    'Æon Flux', 'naïve café', 'Crème brûlée', 'Ångström', 'İstanbul', 'ﬁnal ﬂight', 'Ｆｕｌｌ　Ｗｉｄｔｈ', '①②③',
    'i7-8700K', 'ACS770KCB-150B', 'RTX 4090 Ti', 'Spider-Man: No Way Home', 'Star Wars: Episode IV – A New Hope',
    'Mission: Impossible — Fallout', 'AC/DC', "Guns N' Roses", 'Sgt. Pepper’s Lonely Hearts Club Band', '"Weird Al"',
    'Tom & Jerry', 'Earth, Wind & Fire', 'WALL·E', 'M*A*S*H', 'Se7en', '(500) Days of Summer', '9-1-1: Lone Star',
    'Kill Bill: Vol. 1', 'Ocean’s Eleven', 'Mr. Robot', 'Dr. Stone', 'K-On!', 'Re:Zero', '進撃の巨人', '鬼滅の刃',
    '僕のヒーローアカデミア', '오징어 게임', 'Наруто', 'Ελλάδα', 'עברית', 'العربية', 'हिन्दी', 'ไทย', 'Tiếng Việt',
    '  lots   of\tspace  ', '___under_score___', 'emoji 🎮 game', 'x²', 'Ⅻ Roman', 'ß', 'Œuvre', '½ half', 'DÉJÀ VU',
    'Zürich—Genève', 'a–b—c-d', '', '...', 'trailing.', '.leading',
  ];
  it('mirrors normName exactly', () => {
    expect(samples.length).toBeGreaterThanOrEqual(50);
    for (const s of samples) expect(scriptNormName(s), JSON.stringify(s)).toBe(normName(s));
  });
});
