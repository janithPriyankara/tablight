#!/usr/bin/env node
// Builds public/names/names.txt, the offline name list (design: docs/superpowers/specs/2026-11-20-names-lookup-design.md,
// Part 1). Build-time only; the extension never queries Wikidata for this list.
//
//   npm run names:build -- --scowl DIR [--cache DIR] [--offline]
//
// --scowl  directory holding SCOWL's final/english-words.10, .20 and .35 (the common-word filter; not shipped, see
//          scripts/names/README.md for where to get it and its licence).
// --cache  where raw SPARQL responses are kept (default: <os tmpdir>/tablight-names-raw). Never commit it.
// --offline  use only cached responses; fail on a cache miss.
//
// Source: Wikidata's public SPARQL endpoint and Action API (CC0 1.0), plus English Wikipedia's Action API for title
// redirects. Queries run one at a time with a generic User-Agent and back
// off on 429/5xx/timeouts. Popularity is the sitelink count (number of Wikipedia/Wikimedia articles about the item).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { URLSearchParams, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { normName } from './norm.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(root, 'public', 'names', 'names.txt');
const ENDPOINT = 'https://query.wikidata.org/sparql';
const API = 'https://www.wikidata.org/w/api.php';
const ENWIKI_API = 'https://en.wikipedia.org/w/api.php';
const UA = 'TablightNamesBuild/1.0 (build script)';
/** names.txt cap (also enforced by tests/unit/names-file.test.ts and scripts/verify-release.mjs). */
const BUDGET = 1_450_000;
/** A name claimed by two labels stays only if one label's best entity has at least this many times the sitelinks. */
const DOMINANCE = 5;
const MIN_LEN = 4;
/** "the" + a common word needs the plain title and this many times the group's bar. */
const THE_COMMON_BARS = 4;
const MAX_LEN = 60;
/** SHA-256 of english-words.10 + .20 + .35 concatenated, from SCOWL 2020.12.07 (README). */
const SCOWL_SHA256 = '00fae307ff2e2bc78ca81b1f2cdb0f492b295c9fb41b7526b45ab7553778678c';

// ── classes ─────────────────────────────────────────────────────────────────
// Each group: the label it files into, the instance-of (P31) classes, the minimum sitelink count (bar) and a row
// LIMIT (a safety cap; ORDER BY sitelinks keeps the best-known). Order matters: an item in two groups keeps the first.
// Anime films file under movies (training/LABELING.md: animated feature films -> movies).
// `split` lists the large classes that run in ten slices so each query stays under the endpoint's 60 s limit.
export const GROUPS = [
  { id: 'anime', label: 'anime', bar: 12, limit: 6000, p31: {
    Q63952888: 'anime television series', Q1107: 'anime', Q220898: 'original video animation',
    Q1047299: 'original net animation', Q21198342: 'manga series', Q8274: 'manga', Q747381: 'light novel', Q562214: 'manhwa' } },
  { id: 'games', label: 'games', bar: 8, limit: 30000, p31: { Q7889: 'video game', Q7058673: 'video game series' } },
  { id: 'boardgames', label: 'games', bar: 20, limit: 1000, p31: { Q131436: 'board game' } },
  { id: 'tv', label: 'tv', bar: 10, limit: 15000, split: ['Q5398426'], p31: {
    Q5398426: 'television series', Q1259759: 'miniseries', Q526877: 'web series', Q581714: 'animated series',
    Q117467246: 'animated television series', Q1366112: 'drama television series' } },
  { id: 'tvprog', label: 'tv', bar: 25, limit: 4000, p31: { Q15416: 'television program' } },
  { id: 'movies', label: 'movies', bar: 15, limit: 12000, split: ['Q11424'], p31: {
    Q11424: 'film', Q24869: 'feature film', Q202866: 'animated film', Q29168811: 'animated feature film',
    Q20650540: 'anime film' } },
  { id: 'filmseries', label: 'movies', bar: 25, limit: 2000, p31: { Q24856: 'film series' } },
  { id: 'music', label: 'music', bar: 12, limit: 30000, split: ['Q482994', 'Q208569'], p31: {
    Q215380: 'musical group', Q5741069: 'rock band', Q216337: 'boy band', Q641066: 'girl group', Q9212979: 'musical duo',
    Q482994: 'album', Q208569: 'studio album' } },
  { id: 'books', label: 'books', bar: 15, limit: 8000, split: ['Q7725634', 'Q571'], p31: {
    Q7725634: 'literary work', Q8261: 'novel', Q571: 'book', Q277759: 'book series', Q1667921: 'novel series',
    Q47068459: "children's book series" } },
  { id: 'cars', label: 'cars', bar: 12, limit: 6000, p31: {
    Q786820: 'automobile manufacturer', Q10429667: 'car brand', Q3231690: 'car model', Q59773381: 'car model series' } },
  { id: 'sports', label: 'sports', bar: 15, limit: 10000, p31: {
    Q476028: 'association football club', Q13393265: 'basketball team', Q17156793: 'American football team',
    Q4498974: 'ice hockey team', Q13027888: 'baseball team', Q17376093: 'cricket team',
    Q15991290: 'professional sports league', Q15991303: 'association football league', Q623109: 'sports league',
    Q18608583: 'recurring sporting event', Q103229495: "men's association football team",
    Q20639856: 'professional sports team' } },
  { id: 'hardware', label: 'hardware', bar: 8, limit: 6000, p31: {
    Q5297: 'microprocessor', Q183484: 'graphics processing unit', Q4308: 'graphics card', Q165678: 'microcontroller',
    Q944780: 'single-board computer', Q122901167: 'system on a chip model', Q60484681: 'computer model series' } },
];
/**
 * Semiconductor makers (by industry, P452) and what they make (P176): chips, sockets, microarchitectures, boards,
 * calculators. Wider industries (electrical, electronics) pulled in appliance, camera, train and ship makers, so they
 * are left out; products that are an instance of (a subclass of) one of NOT_HARDWARE are left out too.
 */
export const HARDWARE_INDUSTRIES = { Q2986369: 'semiconductor industry' };
export const NOT_HARDWARE = {
  Q8076: 'video game console', Q15328: 'camera', Q17517: 'mobile phone', Q42889: 'vehicle', Q11436: 'aircraft',
  Q11446: 'ship', Q9135: 'operating system', Q7397: 'software', Q41176: 'building', Q5: 'human',
};
export const HARDWARE_MAKER_BAR = 15;
export const HARDWARE_PRODUCT_BAR = 8;
/**
 * Persons: musicians and athletes only, multi-word names only, at a higher bar (design Part 1, ruling 5). `bar` is the
 * query bar (it is part of the cached query text); `keep` is the bar a person must reach to be kept. `also` lists
 * more occupations of the same field that count towards it (they are not queried for).
 */
export const PERSONS = [
  { id: 'musicians', label: 'music', bar: 40, keep: 40, limit: 6000, occ: {
    Q639669: 'musician', Q177220: 'singer', Q2252262: 'rapper', Q488205: 'singer-songwriter', Q36834: 'composer',
    Q855091: 'guitarist', Q130857: 'disc jockey', Q753110: 'songwriter', Q486748: 'pianist' }, also: {
    Q183945: 'record producer', Q55960555: 'recording artist', Q158852: 'conductor', Q822146: 'lyricist',
    Q1415090: 'film score composer', Q806349: 'bandleader', Q12374149: 'rock musician', Q765778: 'organist',
    Q1075651: 'keyboardist', Q1327329: 'multi-instrumentalist', Q386854: 'drummer', Q584301: 'bassist',
    Q1259917: 'violinist', Q15981151: 'jazz musician', Q60723829: 'pop singer', Q102277154: 'pop musician',
    Q104218554: 'rock singer', Q12800682: 'saxophonist', Q6168364: 'jazz guitarist', Q9648008: 'banjoist',
    Q12377274: 'trumpeter', Q13219637: 'cellist', Q21680663: 'classical composer', Q61996187: 'classical pianist',
    Q2865819: 'opera singer', Q2643890: 'vocalist', Q1643514: 'music arranger', Q3922505: 'DJ producer',
    Q5371902: 'harpsichordist', Q19723482: 'mandolinist', Q12360214: 'bass guitarist', Q105652947: 'soul musician',
    Q66763670: 'country musician', Q215793: 'chapelmaster', Q1076502: 'choir director', Q1198887: 'music director' } },
  // Bot-made stubs give 1930s-60s national-team players 40+ sitelinks, so athletes are queried at 40 but kept at 60.
  { id: 'athletes', label: 'sports', bar: 40, keep: 60, limit: 6000, occ: {
    Q937857: 'association football player', Q3665646: 'basketball player', Q10833314: 'tennis player',
    Q12299841: 'cricketer', Q19204627: 'American football player', Q10871364: 'baseball player',
    Q11774891: 'ice hockey player', Q10841764: 'Formula One driver', Q378622: 'racing driver', Q11338576: 'boxer',
    Q11303721: 'golfer', Q11607585: 'mixed martial arts fighter', Q11513337: 'athletics competitor', Q10843402: 'swimmer' } },
];
/**
 * Occupations that compete with a person's music or sport fame. A person is kept only when their field's occupations
 * outnumber these (a tie is enough from 4 field occupations up: John Lennon, Bob Dylan). Writing occupations overlap
 * (writer, author, novelist, poet ...), so together they count at most WRITING_CAP.
 */
export const OTHER_FAME = {
  Q33999: 'actor', Q10800557: 'film actor', Q10798782: 'television actor', Q2405480: 'voice actor', Q2259451: 'stage actor',
  Q82955: 'politician', Q947873: 'television presenter', Q44508716: 'television personality', Q43845: 'businessperson',
  Q131524: 'entrepreneur', Q3282637: 'film producer', Q2526255: 'film director', Q578109: 'television producer',
  Q3455803: 'director', Q1930187: 'journalist', Q6051619: 'opinion journalist', Q8246794: 'blogger', Q1028181: 'painter',
  Q1281618: 'sculptor', Q644687: 'illustrator', Q33231: 'photographer', Q42973: 'architect', Q15296811: 'draftsperson',
  Q3391743: 'visual artist', Q3501317: 'fashion designer', Q4964182: 'philosopher', Q901: 'scientist', Q169470: 'physicist',
  Q11063: 'astronomer', Q170790: 'mathematician', Q1622272: 'university teacher', Q201788: 'historian', Q14467526: 'linguist',
  Q1234713: 'theologian', Q81096: 'engineer', Q205375: 'inventor', Q39631: 'physician', Q40348: 'lawyer',
  Q250867: 'Catholic priest', Q42603: 'priest', Q116: 'monarch', Q189290: 'military officer', Q47064: 'military personnel',
  Q193391: 'diplomat', Q245068: 'comedian', Q4610556: 'model', Q17125263: 'YouTuber',
};
export const WRITING = {
  Q36180: 'writer', Q6625963: 'novelist', Q49757: 'poet', Q214917: 'playwright', Q482980: 'author', Q11774202: 'essayist',
  Q12144794: 'prose writer', Q15949613: 'short story writer', Q4853732: "children's writer",
  Q18844224: 'science fiction writer', Q4263842: 'literary critic', Q864380: 'biographer', Q333634: 'translator',
  Q18814623: 'autobiographer', Q28389: 'screenwriter', Q69423232: 'film screenwriter',
};
export const WRITING_CAP = 2;
// ── SPARQL with a cache and polite retries ──────────────────────────────────
const { values: args } = parseArgs({
  options: { scowl: { type: 'string' }, cache: { type: 'string' }, offline: { type: 'boolean', default: false } },
});
const CACHE = resolve(args.cache ?? join(tmpdir(), 'tablight-names-raw'));
let queries = 0;
let fetched = 0;
async function sparql(query) {
  queries++;
  const key = createHash('sha256').update(query).digest('hex').slice(0, 24);
  const file = join(CACHE, `${key}.json`);
  if (existsSync(file)) return JSON.parse(await readFile(file, 'utf8')).results.bindings;
  if (args.offline) throw new Error(`cache miss in --offline mode (${key})`);
  for (let attempt = 1; ; attempt++) {
    let status = 0;
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'user-agent': UA, accept: 'application/sparql-results+json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ query }),
        signal: AbortSignal.timeout(90_000),
      });
      status = res.status;
      if (res.ok) {
        const text = await res.text();
        const json = JSON.parse(text); // a truncated (timed-out) body fails here and is retried
        await mkdir(CACHE, { recursive: true });
        await writeFile(file, text);
        await writeFile(join(CACHE, `${key}.rq`), query);
        fetched++;
        await sleep(1500); // one query at a time, with a pause
        return json.results.bindings;
      }
      if (status !== 429 && status < 500) throw new Error(`HTTP ${status}: ${(await res.text()).slice(0, 300)}`);
      const retryAfter = Number(res.headers.get('retry-after'));
      if (attempt >= 6) throw new Error(`HTTP ${status} after ${attempt} attempts`);
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 10_000 * attempt);
    } catch (e) {
      if (/^HTTP 4/.test(e.message) || attempt >= 6) throw e;
      console.warn(`  retry ${attempt} (${status || e.name}): ${e.message.slice(0, 120)}`);
      await sleep(10_000 * attempt);
    }
  }
}
/** A MediaWiki Action API (Wikidata's by default; GET, cached like sparql()). */
async function api(params, host = API) {
  queries++;
  const url = `${host}?${new URLSearchParams({ ...params, format: 'json' })}`;
  const key = `api-${createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
  const file = join(CACHE, `${key}.json`);
  if (existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  if (args.offline) throw new Error(`cache miss in --offline mode (${key})`);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60_000) });
      const text = await res.text();
      const json = res.ok ? JSON.parse(text) : null;
      if (json && !json.error) {
        await mkdir(CACHE, { recursive: true });
        await writeFile(file, text);
        await writeFile(join(CACHE, `${key}.url`), url);
        fetched++;
        await sleep(200);
        return json;
      }
      if (attempt >= 6) throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
    } catch (e) {
      if (attempt >= 6) throw e;
    }
    await sleep(5_000 * attempt);
  }
}
const qid = (b) => b.value.replace('http://www.wikidata.org/entity/', '');
const values = (obj) => Object.keys(obj).map((q) => `wd:${q}`).join(' ');

/** Items (with an English Wikipedia article) matching `pattern`, above `bar` sitelinks: id, sitelinks, label, title. */
async function items(pattern, bar, limit) {
  const rows = await sparql(`SELECT ?item ?sl ?label ?title WHERE {
  ${pattern}
  ?item wikibase:sitelinks ?sl. FILTER(?sl >= ${bar})
  ?article schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>; schema:name ?title.
  ?item rdfs:label ?label. FILTER(LANG(?label) IN ("en", "mul"))
} ORDER BY DESC(?sl) LIMIT ${limit}`);
  if (rows.length >= limit) console.warn(`  warning: a query hit its LIMIT ${limit}; raise it or the bar`);
  return rows.map((r) => ({ id: qid(r.item), sl: Number(r.sl.value), label: r.label.value, title: r.title.value }));
}
/** English aliases of the same items. */
async function aliases(pattern, bar) {
  const rows = await sparql(`SELECT ?item ?alias WHERE {
  ${pattern}
  ?item wikibase:sitelinks ?sl. FILTER(?sl >= ${bar})
  ?item skos:altLabel ?alias. FILTER(LANG(?alias) IN ("en", "mul"))
}`);
  return rows.map((r) => ({ id: qid(r.item), alias: r.alias.value }));
}
function patterns(group, cls) {
  const base = `?item wdt:P31 wd:${cls}.`;
  if (!group.split?.includes(cls)) return [base];
  // Ten slices by the QID's last digit: the filter runs before the sitelink join, so each slice scans a tenth.
  return [...'0123456789'].map((d) => `${base} FILTER(STRENDS(STR(?item), "${d}"))`);
}

// ── collect ─────────────────────────────────────────────────────────────────
/** id -> { id, sl, labels: [], title, group, labelId, person, aliases: [] } */
const entities = new Map();
const classCounts = {};
function add(group, label, it, extra = {}) {
  const had = entities.get(it.id);
  // Many items now carry their name as a "mul" (default for all languages) label instead of, or as well as, "en".
  if (had) return void (had.group === group && !had.labels.includes(it.label) && had.labels.push(it.label));
  const { label: name, ...rest } = it;
  entities.set(it.id, { ...rest, labels: [name], group, labelId: label, aliases: [], ...extra });
  classCounts[group] = (classCounts[group] ?? 0) + 1;
}
async function addAliases(pattern, bar) {
  for (const a of await aliases(pattern, bar)) entities.get(a.id)?.aliases.push(a.alias);
}

console.log(`names: querying Wikidata (cache ${CACHE})`);
for (const g of GROUPS) {
  for (const cls of Object.keys(g.p31)) {
    for (const p of patterns(g, cls)) {
      for (const it of await items(p, g.bar, g.limit)) add(g.id, g.label, it);
      await addAliases(p, g.bar);
    }
  }
  console.log(`  ${g.id}: ${classCounts[g.id] ?? 0} items`);
}
{
  const makers = `?item wdt:P452 ?ind. VALUES ?ind { ${values(HARDWARE_INDUSTRIES)} }`;
  for (const it of await items(makers, HARDWARE_MAKER_BAR, 3000)) add('hwmakers', 'hardware', it);
  await addAliases(makers, HARDWARE_MAKER_BAR);
  // Products: made by those makers, unless an instance of a class under NOT_HARDWARE (closure computed separately; a
  // path query per item times out).
  const under = new Set(
    (await sparql(`SELECT DISTINCT ?c WHERE { ?c wdt:P279* ?root. VALUES ?root { ${values(NOT_HARDWARE)} } }`)).map((r) => qid(r.c)),
  );
  const products = `?item wdt:P176 ?maker. ?maker wdt:P452 ?ind. VALUES ?ind { ${values(HARDWARE_INDUSTRIES)} }`;
  const classesOf = new Map();
  for (const r of await sparql(`SELECT ?item ?cls WHERE {
  ${products}
  ?item wikibase:sitelinks ?sl. FILTER(?sl >= ${HARDWARE_PRODUCT_BAR})
  ?item wdt:P31 ?cls.
}`)) {
    const id = qid(r.item);
    if (!classesOf.has(id)) classesOf.set(id, []);
    classesOf.get(id).push(qid(r.cls));
  }
  const isHardware = (id) => !(classesOf.get(id) ?? []).some((c) => under.has(c));
  let notChip = 0;
  for (const it of await items(products, HARDWARE_PRODUCT_BAR, 6000)) {
    if (isHardware(it.id)) add('hwproducts', 'hardware', it);
    else notChip++;
  }
  for (const a of await aliases(products, HARDWARE_PRODUCT_BAR)) if (isHardware(a.id)) entities.get(a.id)?.aliases.push(a.alias);
  console.log(`  hardware: ${under.size} classes under NOT_HARDWARE; ${notChip} products of those kinds left out`);
  console.log(`  hardware makers ${classCounts.hwmakers ?? 0}, products ${classCounts.hwproducts ?? 0}`);
}
const personDrops = { belowKeep: 0, otherFame: 0, split: 0 };
{
  // One occupation per query: the combined query streams too long and the endpoint cuts it off.
  const found = PERSONS.map(() => new Map());
  const occs = new Map(); // every occupation (P106) of each person found
  for (const [gi, g] of PERSONS.entries()) {
    for (const occ of Object.keys(g.occ)) {
      const pattern = `?item wdt:P106 wd:${occ}; wdt:P31 wd:Q5.`;
      for (const it of await items(pattern, g.bar, g.limit)) found[gi].set(it.id, it);
      const occRows = await sparql(`SELECT ?item ?occ WHERE {
  ${pattern}
  ?item wikibase:sitelinks ?sl. FILTER(?sl >= ${g.bar})
  ?item wdt:P106 ?occ.
}`);
      for (const r of occRows) {
        const id = qid(r.item);
        if (!occs.has(id)) occs.set(id, new Set());
        occs.get(id).add(qid(r.occ));
      }
    }
  }
  // A person goes to the group with strictly the most of their occupations (a basketball player who also recorded an
  // album is sports), and only when those dominate their acting/political/writing/scholarly ones.
  const field = (id, g) => [...(occs.get(id) ?? [])].filter((o) => o in g.occ || o in (g.also ?? {})).length;
  const otherFame = (id) => {
    const o = [...(occs.get(id) ?? [])];
    return o.filter((x) => x in OTHER_FAME).length + Math.min(WRITING_CAP, o.filter((x) => x in WRITING).length);
  };
  const chosen = [];
  for (const [gi, g] of PERSONS.entries()) {
    for (const it of found[gi].values()) {
      if (it.sl < g.keep) {
        personDrops.belowKeep++;
        continue;
      }
      const mine = field(it.id, g);
      const rival = Math.max(0, ...PERSONS.filter((_, k) => k !== gi).map((o) => field(it.id, o)));
      if (mine <= rival) {
        if (gi === 0 || mine === rival) personDrops.split++;
        continue;
      }
      const other = otherFame(it.id);
      if (mine < other || (mine === other && mine < 4)) {
        personDrops.otherFame++;
        continue;
      }
      chosen.push({ g, it });
    }
  }
  for (const { g, it } of chosen) add(g.id, g.label, it, { person: true });
  for (const g of PERSONS) console.log(`  ${g.id}: ${classCounts[g.id] ?? 0} people`);
}
// ── names and ambiguity rules ───────────────────────────────────────────────
async function commonWords(dir) {
  if (!dir) throw new Error('--scowl DIR is required (see scripts/names/README.md)');
  const bufs = [];
  for (const lvl of ['10', '20', '35']) bufs.push(await readFile(join(resolve(dir), `english-words.${lvl}`)));
  const all = Buffer.concat(bufs);
  const sha = createHash('sha256').update(all).digest('hex');
  if (SCOWL_SHA256 && sha !== SCOWL_SHA256) throw new Error(`SCOWL word lists differ from the pinned SHA-256 (${sha})`);
  const set = new Set();
  for (const w of all.toString('latin1').split(/\r?\n/)) {
    const n = normName(w);
    if (n && !n.includes(' ')) set.add(n);
  }
  return { set, sha };
}
const { set: COMMON, sha: scowlSha } = await commonWords(args.scowl);
const BRACKET = /\s*\(([^()]+)\)\s*$/;
const coreWords = (n) => n.replace(/^the /, '').split(' ');
const drops = { short: 0, long: 0, noLetter: 0, digits: 0, common: 0, theCommon: 0, commonPhrase: 0, notPrimary: 0, singleAlias: 0, singlePerson: 0, titleOwner: 0, labelOwner: 0, ambiguous: 0, budget: 0 };
const ucfirst = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const sentenceCase = (t) => t.charAt(0) + t.slice(1).toLowerCase();
/** Names that pass the word rules, before the other-owner check: { name, e, kind, owns, lookups }. */
const candidates = [];
function claim(name, e, kind, raw) {
  if (name.length < MIN_LEN) return void drops.short++;
  if (name.length > MAX_LEN) return void drops.long++;
  if (!/\p{L}/u.test(name)) return void drops.noLetter++;
  if (/^[\d ]+$/.test(name)) return void drops.digits++;
  const words = name.split(' ');
  const oneCore = coreWords(name).length === 1; // "the wire" is one core word
  const bracketed = BRACKET.test(e.title);
  const primary = !bracketed && normName(e.title) === name;
  if (e.person) {
    // People: their own unbracketed Wikipedia title only, at least two words; no aliases (birth names, nicknames).
    if (kind !== 'label' || !primary) return void drops.notPrimary++;
    if (oneCore) return void drops.singlePerson++;
  }
  if (words.length === 1 && COMMON.has(name)) return void drops.common++;
  // The same filter after a leading "the": "the music", "the cars", "the streets" are everyday words, not a band search.
  // Only an item that owns the plain title and is very well known (4x its group's bar) keeps one: "The Godfather",
  // "The Matrix", "The Who".
  if (words.length === 2 && words[0] === 'the' && COMMON.has(words[1])) {
    if (!(primary && kind === 'label' && e.sl >= THE_COMMON_BARS * GROUP_BAR[e.group])) return void drops.theCommon++;
  }
  if (oneCore) {
    // One word (or "the" + one word): only when Wikipedia gives this item the bare title, so it is the primary topic
    // ("Metallica" stays; "Halo (franchise)", "The Office (American TV series)" do not).
    if (kind === 'alias') return void drops.singleAlias++;
    if (!primary) return void drops.notPrimary++;
  } else if (
    words.every((w) => COMMON.has(w)) &&
    (kind === 'alias' || bracketed || (coreWords(name).length < 3 && e.sl < 2 * GROUP_BAR[e.group]))
  ) {
    // An everyday phrase ("lost in space", "the other side") only from an item that owns the bare title, and a two-word
    // one ("good time") only from an item at twice its group's bar; longer ones ("doom at your service") are specific.
    return void drops.commonPhrase++;
  }
  const owns = primary && kind === 'label';
  // Who else Wikipedia or Wikidata gives these words to (checked below). An item that owns its plain title is the
  // primary topic, unless the title is oddly cased and the plainly cased title is another article ("DaDa" the album
  // against "Dada" the art movement).
  const lookups = new Set();
  if (!owns) {
    lookups.add(ucfirst(raw.trim()));
    const bare = e.title.replace(BRACKET, '');
    if (bracketed && normName(bare) === name) lookups.add(bare);
  } else if (/\p{Lu}/u.test(e.title.slice(1)) && !e.title.includes(' ')) {
    lookups.add(sentenceCase(e.title));
  }
  candidates.push({ name, e, kind, owns, lookups: [...lookups] });
}
const GROUP_BAR = Object.fromEntries([
  ...GROUPS.map((g) => [g.id, g.bar]), ...PERSONS.map((g) => [g.id, g.bar]),
  ['hwmakers', HARDWARE_MAKER_BAR], ['hwproducts', HARDWARE_PRODUCT_BAR],
]);
for (const e of entities.values()) {
  const own = new Set();
  // Each name also without its apostrophes ("Baldur's Gate 3" -> "baldurs gate 3"), the way people type it.
  const offer = (raw, kind) => {
    const forms = [normName(raw)];
    if (/['’]/.test(raw)) forms.push(normName(raw.replace(/['’]/g, '')));
    for (const n of forms) {
      if (own.has(n)) continue;
      own.add(n);
      claim(n, e, kind, raw);
    }
  };
  for (const l of e.labels) offer(l, 'label');
  if (!BRACKET.test(e.title)) offer(e.title, 'label');
  for (const a of e.aliases) offer(a, 'alias');
}
// ── other owners ────────────────────────────────────────────────────────────
// A name an item does not own as its plain Wikipedia title ("San Francisco (1936 film)" -> "san francisco", the
// label "Robert Bosch" of "Bosch (company)", an alias) is dropped when the words belong to something outside the list:
//  - the English Wikipedia article with that title is a disambiguation page, a person, or an item with at least as
//    many sitelinks ("New York", "Groundhog Day", "Michael Collins");
//  - or another item with that English label has at least as many sitelinks.
// Items in the list are left to the dominance rule below.
const titleOwner = new Map(); // title -> { id, sl, dis, hum }
const labelOwners = new Map(); // label -> [{ id, sl, dis }]
{
  const strings = [...new Set(candidates.flatMap((c) => c.lookups))].sort();
  for (let i = 0; i < strings.length; i += 500) {
    const chunk = strings.slice(i, i + 500);
    const en = chunk.map((t) => `${JSON.stringify(t)}@en`).join(' ');
    for (const r of await sparql(`SELECT ?t ?i ?sl ?dis ?hum WHERE {
  VALUES ?t { ${en} }
  ?a schema:name ?t; schema:isPartOf <https://en.wikipedia.org/>; schema:about ?i.
  ?i wikibase:sitelinks ?sl.
  OPTIONAL { ?i wdt:P31 wd:Q4167410. BIND(1 AS ?dis) }
  OPTIONAL { ?i wdt:P31 wd:Q5. BIND(1 AS ?hum) }
}`)) titleOwner.set(r.t.value, { id: qid(r.i), sl: Number(r.sl.value), dis: !!r.dis, hum: !!r.hum });
    // Labels in smaller slices: a slice with many popular labels otherwise runs past the endpoint's time limit.
    for (let j = 0; j < chunk.length; j += 125) {
      const both = chunk.slice(j, j + 125).flatMap((t) => [`${JSON.stringify(t)}@en`, `${JSON.stringify(t)}@mul`]).join(' ');
      for (const r of await sparql(`SELECT ?t ?i ?sl ?dis WHERE {
  VALUES ?t { ${both} }
  ?i rdfs:label ?t; wikibase:sitelinks ?sl. FILTER(?sl >= 8)
  OPTIONAL { ?i wdt:P31 wd:Q4167410. BIND(1 AS ?dis) }
}`)) {
        const t = r.t.value;
        if (!labelOwners.has(t)) labelOwners.set(t, []);
        labelOwners.get(t).push({ id: qid(r.i), sl: Number(r.sl.value), dis: !!r.dis });
      }
    }
  }
  // Wikipedia titles are case-sensitive after the first letter: "American Football (band)" also checks
  // "American football" (the sport). The plainly cased variants are looked up through the API, 50 titles a call.
  const known = new Set(strings);
  const variants = [...new Set(strings.filter((t) => t.includes(' ')).map(sentenceCase))].filter((v) => !known.has(v) && !/[|#<>[\]{}]/.test(v)).sort(); // no characters a title cannot hold
  for (let i = 0; i < variants.length; i += 50) {
    const res = await api({ action: 'wbgetentities', sites: 'enwiki', titles: variants.slice(i, i + 50).join('|'), props: 'sitelinks', redirects: 'no' });
    for (const [id, ent] of Object.entries(res.entities ?? {})) {
      const t = ent.sitelinks?.enwiki?.title;
      if (id.startsWith('Q') && t) titleOwner.set(t, { id, sl: Object.keys(ent.sitelinks).length, dis: false, hum: false });
    }
  }
  // A bracketed article's bare title can also be a redirect ("Van Gogh" -> "Vincent van Gogh") or a disambiguation page
  // under its plain name; ask English Wikipedia where each one leads, then Wikidata how well known the target is.
  const bares = [...new Set([...entities.values()].filter((e) => BRACKET.test(e.title)).map((e) => e.title.replace(BRACKET, '')))]
    .filter((t) => !titleOwner.has(t) && !/[|#<>[\]{}]/.test(t))
    .sort();
  const leadsTo = new Map(); // bare title -> { id, dis }
  for (let i = 0; i < bares.length; i += 50) {
    const res = await api({ action: 'query', titles: bares.slice(i, i + 50).join('|'), redirects: '1', prop: 'pageprops', ppprop: 'wikibase_item|disambiguation', formatversion: '2' }, ENWIKI_API);
    const step = new Map([...(res.query?.normalized ?? []), ...(res.query?.redirects ?? [])].map((x) => [x.from, x.to]));
    const pages = new Map((res.query?.pages ?? []).map((p) => [p.title, p]));
    for (const t of bares.slice(i, i + 50)) {
      let cur = t;
      for (let k = 0; k < 4 && step.has(cur); k++) cur = step.get(cur);
      const page = pages.get(cur);
      if (cur !== t && page?.pageprops?.wikibase_item) leadsTo.set(t, { id: page.pageprops.wikibase_item, dis: 'disambiguation' in page.pageprops });
    }
  }
  const targets = [...new Set([...leadsTo.values()].map((o) => o.id))].sort();
  const targetSl = new Map();
  for (let i = 0; i < targets.length; i += 50) {
    const res = await api({ action: 'wbgetentities', ids: targets.slice(i, i + 50).join('|'), props: 'sitelinks' });
    for (const [id, ent] of Object.entries(res.entities ?? {})) targetSl.set(id, Object.keys(ent.sitelinks ?? {}).length);
  }
  for (const [t, o] of leadsTo) titleOwner.set(t, { id: o.id, sl: targetSl.get(o.id) ?? 0, dis: o.dis, hum: false });
  console.log(`  bare titles that redirect: ${leadsTo.size} of ${bares.length}`);
  console.log(`  other-owner check: ${strings.length} strings (+${variants.length} cased variants), ${titleOwner.size} with an enwiki article, ${labelOwners.size} with a label`);
}
/** name -> Map(label -> { sl, rel, owns, named }) */
const claims = new Map();
for (const { name, e, kind, owns, lookups } of candidates) {
  const outside = (o) => o && o.id !== e.id && !entities.has(o.id);
  const owners = lookups.flatMap((t) => [titleOwner.get(t), t.includes(' ') ? titleOwner.get(sentenceCase(t)) : undefined]);
  if (owners.some((o) => outside(o) && (o.dis || o.hum || 2 * o.sl >= e.sl))) {
    drops.titleOwner++;
    continue;
  }
  if (lookups.some((t) => (labelOwners.get(t) ?? []).some((o) => outside(o) && !o.dis && o.sl >= e.sl))) {
    drops.labelOwner++;
    continue;
  }
  let c = claims.get(name);
  if (!c) claims.set(name, (c = new Map()));
  const prev = c.get(e.labelId);
  const bar = GROUP_BAR[e.group];
  // Any label (bracketed article or not) is a real claim; only an alias is weak (see the owner exception below).
  const named = kind === 'label';
  if (!prev) c.set(e.labelId, { sl: e.sl, rel: e.sl / bar, owns, named });
  else {
    if (e.sl > prev.sl) Object.assign(prev, { sl: e.sl, rel: e.sl / bar });
    prev.owns ||= owns;
    prev.named ||= named;
  }
}
const kept = [];
for (const [name, c] of claims) {
  const ranked = [...c.entries()].sort((a, b) => b[1].sl - a[1].sl);
  const [best, second] = ranked;
  // The item Wikipedia gives the bare title to keeps it against other labels that claim it only by an alias ("The
  // Shawshank Redemption" the film, against the novella's alias). A rival's label, bracketed or not, goes to the 5x rule
  // ("Mortal Kombat" the game against the film).
  const owner = best[1].owns && ranked.slice(1).every(([, o]) => !o.named);
  if (second && !owner && best[1].sl < DOMINANCE * second[1].sl) {
    drops.ambiguous++;
    continue;
  }
  kept.push({ name, label: best[0], sl: best[1].sl, rel: best[1].rel });
}
// Fill the budget best-known first (sitelinks relative to the group's bar, so small fields are not crowded out).
kept.sort((a, b) => b.rel - a.rel || b.sl - a.sl || (a.name < b.name ? -1 : 1));
const byLabel = new Map();
let bytes = 0;
for (const k of kept) {
  const cost = Buffer.byteLength(k.name) + 1 + (byLabel.has(k.label) ? 0 : k.label.length + 2);
  if (bytes + cost > BUDGET) {
    drops.budget++;
    continue;
  }
  bytes += cost;
  if (!byLabel.has(k.label)) byLabel.set(k.label, []);
  byLabel.get(k.label).push(k.name);
}
const labels = [...byLabel.keys()].sort();
const text = labels.map((l) => `#${l}\n${byLabel.get(l).sort().join('\n')}\n`).join('');
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, text);

console.log(`\nnames: ${queries} queries (${fetched} fetched, ${queries - fetched} cached); ${entities.size} items`);
console.log(`  per class group: ${Object.entries(classCounts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  people dropped: below keep bar ${personDrops.belowKeep}, other fame ${personDrops.otherFame}, music/sport tie or other side ${personDrops.split}`);
console.log(`  names dropped: ${Object.entries(drops).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  per label: ${labels.map((l) => `${l} ${byLabel.get(l).length}`).join(', ')}`);
console.log(`  SCOWL common words: ${COMMON.size} (sha256 ${scowlSha})`);
console.log(`  wrote ${OUT}: ${Buffer.byteLength(text)} bytes, sha256 ${createHash('sha256').update(text).digest('hex')}`);
