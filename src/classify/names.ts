// The offline name matcher: whole-core lookups of a tab's search query or title in a bundled name list, plus explicit
// hardware part-number patterns. Pure; no chrome APIs.
/** Normalized name -> label id. */
export type NameIndex = ReadonlyMap<string, string>;
export type CoreSource = 'search' | 'wikipedia' | 'title';
/** Lowercase, diacritics stripped, anything that is not a letter or digit becomes a space, collapsed and trimmed. */
export function normName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
/** `#<label>` section lines, then one normalized name per line; blank lines are ignored. First section wins a repeat. */
export function parseNames(text: string): NameIndex {
  const out = new Map<string, string>();
  let label = '';
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) label = t.slice(1).trim();
    else if (label && !out.has(t)) out.set(t, label);
  }
  return out;
}
const SEARCH_PARAM: [RegExp, RegExp, string][] = [
  [/(^|\.)google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/, /^\/search\/?$/, 'q'],
  [/(^|\.)bing\.com$/, /^\/search\/?$/, 'q'],
  [/(^|\.)duckduckgo\.com$/, /./, 'q'],
  [/(^|\.)search\.yahoo\.com$/, /^\/search/, 'p'],
  [/(^|\.)search\.brave\.com$/, /^\/search\/?$/, 'q'],
  [/(^|\.)ecosia\.org$/, /^\/search\/?$/, 'q'],
  [/(^|\.)startpage\.com$/, /^\/(?:sp|do)\/search\/?$/, 'query'],
];
function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
function searchQuery(u: URL): string | null {
  const host = u.hostname.toLowerCase();
  for (const [h, path, param] of SEARCH_PARAM) {
    if (h.test(host) && path.test(u.pathname)) {
      const q = u.searchParams.get(param) ?? (param === 'query' ? u.searchParams.get('q') : null);
      if (q && q.trim()) return q.trim();
    }
  }
  return null;
}
const NOISE =
  'season \\d+|episode \\d+|ending explained|full movie|release date|cast|trailer|imdb|wiki|review|ost|datasheet|price|specs|(?:19[5-9]\\d|20[0-2]\\d)';
const SEP = '[\\s,:;|·–—-]+';
const NOISE_END = new RegExp(`${SEP}(?:${NOISE})$`, 'i');
const NOISE_ALL = new RegExp(`^(?:${NOISE})$`, 'i');
// At the start only the numbered forms: a bare "cast" or "price" opens real titles (Cast Away, Price Tag).
const NOISE_START = new RegExp(`^(?:season \\d+|episode \\d+)${SEP}`, 'i');
const MODEL_BEFORE_YEAR = /(?:^|\s)(?:rtx|gtx|rx|i[3579])[\s-]+(?:19[5-9]\d|20[0-2]\d)$/i;
function stripNoise(s: string): string {
  let cur = s.replace(/\s+/g, ' ').trim();
  for (;;) {
    if (NOISE_ALL.test(cur) && !/^\d{4}$/.test(cur)) return '';
    if (/^\d{4}$/.test(cur)) return cur;
    if (MODEL_BEFORE_YEAR.test(cur)) return cur;
    const next = cur.replace(NOISE_END, '').replace(NOISE_START, '').trim();
    if (next === cur) return cur;
    cur = next;
  }
}
const SITE_SUFFIX = /\s+[-|—–·•]\s+[^-|—–·•]{1,40}$/u;
const WIKI_SUFFIX = /\s+[-–—]\s+Wikipedia$/i;
const WIKI_BRACKET = /\s*\(([^()]+)\)\s*$/;
function isWikipedia(u: URL): boolean {
  return /(^|\.)wikipedia\.org$/i.test(u.hostname);
}
/** The label a Wikipedia "(…)" disambiguator decides, by whole phrase or by its last words ("2019 film"). */
export const WIKI_DISAMBIG: Record<string, string> = {
  'tv series': 'tv',
  'television series': 'tv',
  'tv program': 'tv',
  'tv show': 'tv',
  film: 'movies',
  'video game': 'games',
  band: 'music',
  album: 'music',
  singer: 'music',
  rapper: 'music',
  novel: 'books',
  manga: 'anime',
  'anime series': 'anime',
  microcontroller: 'hardware',
  processor: 'hardware',
  'graphics card': 'hardware',
  'single-board computer': 'hardware',
};
function hasWikiBracket(url: string, title: string): boolean {
  const u = parse(url);
  return !!u && isWikipedia(u) && WIKI_SUFFIX.test(title) && WIKI_BRACKET.test(title.replace(WIKI_SUFFIX, '').trim());
}

function wikiDisambig(url: string, title: string): string | null {
  const u = parse(url);
  if (!u || !isWikipedia(u) || !WIKI_SUFFIX.test(title)) return null;
  const m = title.replace(WIKI_SUFFIX, '').trim().match(WIKI_BRACKET);
  if (!m) return null;
  const d = (m[1] ?? '').toLowerCase().trim();
  for (const [key, label] of Object.entries(WIKI_DISAMBIG)) {
    if (d === key || d.endsWith(` ${key}`)) return label;
  }
  return null;
}
/**
 * What a tab is "about": the search query, the Wikipedia title, or the title without its site suffix; noise words and
 * years trimmed at both ends. `core` is normalized, `raw` is the same text with its case and dashes kept.
 */
export function tabCore(url: string, title: string): { core: string; raw: string; source: CoreSource } | null {
  const u = parse(url);
  let text: string;
  let source: CoreSource;
  const q = u ? searchQuery(u) : null;
  if (q) {
    text = q;
    source = 'search';
  } else if (u && isWikipedia(u) && WIKI_SUFFIX.test(title)) {
    text = title.replace(WIKI_SUFFIX, '').replace(WIKI_BRACKET, '');
    source = 'wikipedia';
  } else {
    text = title.trim().replace(SITE_SUFFIX, '');
    source = 'title';
  }
  const raw = stripNoise(text);
  const core = normName(raw);
  return core ? { core, raw, source } : null;
}
const SPECIFIC_PARTS: RegExp[] = [
  /^(?:intel )?(?:core )?i[3579] \d{4,5}[a-z]{0,2}$/,
  /^ryzen [3579] \d{4}[a-z0-9]{0,3}$/,
  /^(?:nvidia |amd )?(?:rtx|gtx|rx) \d{3,4}(?: (?:ti|super|xt|xtx))*$/,
  /^esp(?:32|8266)(?: [a-z0-9]{1,8})?$/,
  /^stm32[a-z0-9]*$/,
  /^at(?:mega|tiny)\d+[a-z0-9]*$/,
  /^rp2040$/,
  /^nrf52\d*$/,
  /^raspberry pi(?: (?:zero|pico|\d[a-z0-9]*)(?: [a-z0-9]{1,4})?)?$/,
  /^arduino(?: (?:uno|nano|mega|due|leonardo|micro|pro mini))?$/,
];
const DATASHEET_HOSTS =
  /(^|\.)(digikey\.[a-z.]+|mouser\.[a-z.]+|lcsc\.com|octopart\.com|alldatasheet\.com|farnell\.com|ti\.com|st\.com|microchip\.com|infineon\.com|nxp\.com)$/;
function genericPart(raw: string): boolean {
  if (raw.length < 6 || !/^[a-z][a-z0-9-]*$/i.test(raw) || !/\d/.test(raw)) return false;
  return raw.includes('-') || (raw.match(/\d+/g) ?? []).length >= 2;
}
/**
 * Hardware part numbers. The family patterns count anywhere; the generic manufacturer shape only on a search query,
 * a datasheet or distributor site, or a title containing "datasheet" (`opts.title`).
 */
export function partNumberLabel(
  core: string,
  url: string,
  source: CoreSource,
  opts: { raw?: string; title?: string } = {},
): 'hardware' | null {
  if (SPECIFIC_PARTS.some((p) => p.test(core))) return 'hardware';
  const u = parse(url);
  const gated =
    source === 'search' ||
    (u !== null && DATASHEET_HOSTS.test(u.hostname.toLowerCase())) ||
    /datasheet/i.test(opts.title ?? '');
  if (!gated) return null;
  const raw = (opts.raw ?? core.replace(/ /g, '-')).trim();
  return genericPart(raw) ? 'hardware' : null;
}
/** Wikipedia disambiguator, then part-number patterns, then an exact whole-core lookup (also without its own "the "). */
export function nameLabel(url: string, title: string, index: NameIndex | null): string | null {
  const wiki = wikiDisambig(url, title);
  if (wiki) return wiki;
  if (hasWikiBracket(url, title)) return null; // an unmapped disambiguator ("Mercury (element)") is not the bare name

  const c = tabCore(url, title);
  if (!c) return null;
  const part = partNumberLabel(c.core, url, c.source, { raw: c.raw, title });
  if (part) return part;
  if (!index) return null;
  const hit = index.get(c.core);
  if (hit) return hit;
  return c.core.startsWith('the ') ? (index.get(c.core.slice(4)) ?? null) : null;
}
