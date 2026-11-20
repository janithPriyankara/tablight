import { describe, expect, it } from 'vitest';
import { nameLabel, normName, parseNames, partNumberLabel, tabCore } from '../../src/classify/names';
const idx = parseNames('#tv\njack ryan\n#movies\nthe admiral\n\n#hardware\nnvidia\n');
describe('parseNames / normName', () => {
  it('reads sections and ignores blank lines', () => {
    expect(idx.get('jack ryan')).toBe('tv');
    expect(idx.get('the admiral')).toBe('movies');
    expect(idx.get('nvidia')).toBe('hardware');
    expect(idx.size).toBe(3);
  });
  it('reads `#<label>.person` sections as that label', () => {
    const i = parseNames('#sports\nreal madrid\n#sports.person\ndavid silva\n#music.person\nbob dylan\n');
    expect(i.get('real madrid')).toBe('sports');
    expect(i.get('david silva')).toBe('sports');
    expect(i.get('bob dylan')).toBe('music');
  });
  it('normalizes case, diacritics and punctuation', () => {
    expect(normName('  Amélie: The  Movie! ')).toBe('amelie the movie');
    expect(normName('i7-8700K')).toBe('i7 8700k');
  });
});
describe('tabCore', () => {
  it('reads search queries from the supported engines', () => {
    expect(tabCore('https://www.google.com/search?q=jack+ryan', 'x - Google Search')).toMatchObject({ core: 'jack ryan', source: 'search' });
    expect(tabCore('https://search.yahoo.com/search?p=jack+ryan', 'x')).toMatchObject({ core: 'jack ryan', source: 'search' });
    expect(tabCore('https://duckduckgo.com/?q=jack+ryan', 'x')).toMatchObject({ source: 'search' });
  });
  it('keeps raw un-normalized', () => {
    expect(tabCore('https://www.google.com/search?q=ACS770KCB-150B+datasheet', 'x')).toEqual({ core: 'acs770kcb 150b', raw: 'ACS770KCB-150B', source: 'search' });
  });
  it('uses the Wikipedia title and the site suffix', () => {
    expect(tabCore('https://en.wikipedia.org/wiki/Foo', 'Foo - Wikipedia')).toMatchObject({ core: 'foo', source: 'wikipedia' });
    expect(tabCore('https://example.com/a', 'Jack Ryan | Example')).toMatchObject({ core: 'jack ryan', source: 'title' });
  });
  it('trims noise words and years at both ends; null when empty', () => {
    expect(tabCore('https://www.google.com/search?q=jack+ryan+season+2+cast', 'x')?.core).toBe('jack ryan');
    expect(tabCore('https://www.google.com/search?q=jack+ryan+2019+imdb', 'x')?.core).toBe('jack ryan');
    expect(tabCore('https://www.google.com/search?q=cast', 'x')).toBeNull();
    expect(tabCore('https://example.com/', '')).toBeNull();
  });
});
describe('store and listing suffixes', () => {
  it('strips " on Steam" like a site suffix', () => {
    expect(tabCore('https://store.steampowered.com/app/1086940/', "Baldur's Gate 3 on Steam")).toMatchObject({ core: 'baldur s gate 3', source: 'title' });
    expect(tabCore('https://store.steampowered.com/app/1245620/', 'Save 40% on ELDEN RING on Steam')?.core).toBe('elden ring');
    // A Steam page title is a plain title: the list does not match it (the store rule files Steam app pages).
    expect(nameLabel('https://store.steampowered.com/app/1086940/', "Baldur's Gate 3 on Steam", parseNames('#games\nbaldur s gate 3\n'))).toBeNull();
  });
  it('strips a trailing bracketed year', () => {
    expect(tabCore('https://www.imdb.com/title/tt15398776/', 'Oppenheimer (2023) - IMDb')?.core).toBe('oppenheimer');
    expect(tabCore('https://www.imdb.com/title/tt5753856/', 'Dark (TV Series 2017–2020) - IMDb')?.core).toBe('dark');
    expect(tabCore('https://www.google.com/search?q=blade+runner+2049+(2017)', 'x')?.core).toBe('blade runner 2049');
    // Only a year: other brackets stay, so the title is not a bare name.
    expect(tabCore('https://example.com/a', 'Oppenheimer (director’s cut)')?.core).toBe('oppenheimer director s cut');
  });
});
describe('list names match only searches and Wikipedia', () => {
  const people = parseNames('#sports.person\ndavid silva\n#music\nmetallica\n');
  it('never match on a plain page title', () => {
    expect(nameLabel('https://www.linkedin.com/in/david-silva-123', 'David Silva | LinkedIn', people)).toBeNull();
    expect(nameLabel('https://example.com/about', 'David Silva', people)).toBeNull();
  });
  it('match on a search query and on Wikipedia', () => {
    expect(nameLabel('https://www.google.com/search?q=david+silva', 'david silva - Google Search', people)).toBe('sports');
    expect(nameLabel('https://en.wikipedia.org/wiki/David_Silva', 'David Silva - Wikipedia', people)).toBe('sports');
  });
  it('a plain title of a name that is not a person does not match either; a search for it does', () => {
    expect(nameLabel('https://example.com/band', 'Metallica', people)).toBeNull();
    expect(nameLabel('https://example.com/band', 'Metallica | Official Site', people)).toBeNull();
    expect(nameLabel('https://www.google.com/search?q=metallica', 'metallica - Google Search', people)).toBe('music');
    expect(nameLabel('https://en.wikipedia.org/wiki/Metallica', 'Metallica - Wikipedia', people)).toBe('music');
  });
  it('a part-number title still matches', () => {
    expect(nameLabel('https://example.com/review', 'RTX 4090', people)).toBe('hardware');
    expect(nameLabel('https://www.mouser.com/ProductDetail/x', 'ACS770KCB-150B', people)).toBe('hardware');
  });
});
describe('titles that look like noise', () => {
  const core = (t: string) => tabCore('https://example.com/a', t)?.core;
  it('keeps real titles whole', () => {
    expect(core('Cast Away')).toBe('cast away');
    expect(core('Price Tag')).toBe('price tag');
    expect(core('Trailer Park Boys')).toBe('trailer park boys');
    expect(core('2012')).toBe('2012');
    expect(core('1984')).toBe('1984');
    expect(core('2001: A Space Odyssey')).toBe('2001 a space odyssey');
    expect(core('RTX 2000')).toBe('rtx 2000');
    expect(core('Season 2 Jack Ryan')).toBe('jack ryan');
  });
  it('only a real search results page counts as a search', () => {
    expect(tabCore('https://drive.google.com/drive/search?q=type:pdf', 'x')?.source).toBe('title');
    expect(tabCore('https://www.google.com/maps/search/?q=cafe', 'x')?.source).toBe('title');
  });
});
describe('nameLabel', () => {
  it('does not use a bare name when a Wikipedia disambiguator is unmapped', () => {
    const i = parseNames('#music\nmercury\npython\n');
    expect(nameLabel('https://en.wikipedia.org/wiki/Mercury_(element)', 'Mercury (element) - Wikipedia', i)).toBeNull();
    expect(nameLabel('https://en.wikipedia.org/wiki/Python_(programming_language)', 'Python (programming language) - Wikipedia', i)).toBeNull();
  });
  it('rejects loose hardware lookalikes', () => {
    for (const t of ['Arduino projects for kids', 'i7', 'RTX', 'why the RTX 4090 is overpriced', '2019']) {
      expect(nameLabel('https://example.com/a', t, null), t).toBeNull();
    }
  });
  it('matches search queries against the index', () => {
    expect(nameLabel('https://www.google.com/search?q=jack+ryan', 'jack ryan - Google Search', idx)).toBe('tv');
    expect(nameLabel('https://www.bing.com/search?q=The+Admiral', 'The Admiral - Search', idx)).toBe('movies');
    expect(nameLabel('https://www.google.com/search?q=jack+ryan+season+2+cast', 'x', idx)).toBe('tv');
  });
  it('drops only the core\'s own leading "the"', () => {
    const i = parseNames('#movies\nadmiral\nthe admiral\n');
    expect(nameLabel('https://www.google.com/search?q=the+admiral', 'x', parseNames('#movies\nadmiral\n'))).toBe('movies');
    expect(nameLabel('https://www.google.com/search?q=admiral', 'x', parseNames('#movies\nthe admiral\n'))).toBeNull();
    expect(i.size).toBe(2);
  });
  it('uses the Wikipedia disambiguator', () => {
    const w = (t: string) => nameLabel(`https://en.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}`, `${t} - Wikipedia`, null);
    expect(w('Foo (TV series)')).toBe('tv');
    expect(w('Foo (video game)')).toBe('games');
    expect(w('Foo (film)')).toBe('movies');
    expect(w('Foo (band)')).toBe('music');
    expect(w('Foo (2019 film)')).toBe('movies');
  });
  it('matches a plain title never, a Wikipedia title exactly', () => {
    expect(nameLabel('https://www.nvidia.com/', 'NVIDIA', idx)).toBeNull();
    expect(nameLabel('https://en.wikipedia.org/wiki/Nvidia', 'Nvidia - Wikipedia', idx)).toBe('hardware');
  });
  it('recognizes part numbers anywhere', () => {
    for (const t of ['i7 8700', 'i7-8700K', 'Ryzen 5 5600X', 'RTX 4090', 'ESP32-S3', 'STM32F103C8T6', 'ATmega328P', 'RP2040']) {
      expect(nameLabel('https://example.com/post', t, null), t).toBe('hardware');
    }
  });
  it('generic part numbers need a search, a distributor or "datasheet"', () => {
    expect(nameLabel('https://www.google.com/search?q=ACS770KCB-150B', 'x', null)).toBe('hardware');
    expect(nameLabel('https://www.mouser.com/ProductDetail/x', 'ACS770KCB-150B', null)).toBe('hardware');
    expect(nameLabel('https://blog.example.com/p', 'ACS770KCB-150B', null)).toBeNull();
    expect(partNumberLabel('acs770kcb 150b', 'https://blog.example.com/p', 'title', { raw: 'ACS770KCB-150B', title: 'ACS770KCB-150B datasheet' })).toBe('hardware');
  });
  it('sentences and codes never match', () => {
    expect(nameLabel('https://example.com/a', 'how jack ryan changed spy fiction', idx)).toBeNull();
    expect(nameLabel('https://www.google.com/search?q=how+jack+ryan+changed+spy+fiction', 'x', idx)).toBeNull();
    for (const t of ['ERR_CONNECTION_REFUSED', 'COVID19', 'B0CXYZ1234']) {
      expect(nameLabel('https://example.com/a', t, idx), t).toBeNull();
    }
  });
  it('is null without an index and without a disambiguator or part number', () => {
    expect(nameLabel('https://www.google.com/search?q=jack+ryan', 'x', null)).toBeNull();
  });
});
