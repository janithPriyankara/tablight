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
// Source: Wikidata's public SPARQL endpoint (CC0 1.0). Queries run one at a time with a generic User-Agent and back
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
const UA = 'TablightNamesBuild/1.0 (build script)';
/** names.txt cap (also enforced by tests/unit/names-file.test.ts and scripts/verify-release.mjs). */
const BUDGET = 1_450_000;
/** A name claimed by two labels stays only if one label's best entity has at least this many times the sitelinks. */
const DOMINANCE = 5;
const MIN_LEN = 4;
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
/** Persons: musicians and athletes only, multi-word names only, at a higher bar (design Part 1, ruling 5). */
export const PERSONS = [
  { id: 'musicians', label: 'music', bar: 40, limit: 6000, occ: {
    Q639669: 'musician', Q177220: 'singer', Q2252262: 'rapper', Q488205: 'singer-songwriter', Q36834: 'composer',
    Q855091: 'guitarist', Q130857: 'disc jockey', Q753110: 'songwriter', Q486748: 'pianist' } },
  { id: 'athletes', label: 'sports', bar: 40, limit: 6000, occ: {
    Q937857: 'association football player', Q3665646: 'basketball player', Q10833314: 'tennis player',
    Q12299841: 'cricketer', Q19204627: 'American football player', Q10871364: 'baseball player',
    Q11774891: 'ice hockey player', Q10841764: 'Formula One driver', Q378622: 'racing driver', Q11338576: 'boxer',
    Q11303721: 'golfer', Q11607585: 'mixed martial arts fighter', Q11513337: 'athletics competitor', Q10843402: 'swimmer' } },
];
/** Occupations that compete with a person's music or sport fame; a person is kept only if the domain ones outnumber them. */
export const OTHER_FAME = {
  Q33999: 'actor', Q10800557: 'film actor', Q10798782: 'television actor', Q2405480: 'voice actor', Q82955: 'politician',
  Q947873: 'television presenter', Q43845: 'businessperson', Q3282637: 'film producer', Q2526255: 'film director',
};

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
const personDrops = { otherFame: 0, split: 0 };
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
  // album is sports), and only when those outnumber their acting/political/business ones.
  const count = (id, set) => [...(occs.get(id) ?? [])].filter((o) => o in set).length;
  for (const [gi, g] of PERSONS.entries()) {
    for (const it of found[gi].values()) {
      const mine = count(it.id, g.occ);
      const rival = Math.max(0, ...PERSONS.filter((_, k) => k !== gi).map((o) => count(it.id, o.occ)));
      if (mine <= rival) {
        if (gi === 0 || mine === rival) personDrops.split++;
        continue;
      }
      if (mine <= count(it.id, OTHER_FAME)) {
        personDrops.otherFame++;
        continue;
      }
      add(g.id, g.label, it, { person: true });
    }
    console.log(`  ${g.id}: ${classCounts[g.id] ?? 0} people`);
  }
}
// ── bracketed titles whose bare title is a person ───────────────────────────
// "Ada Lovelace (microarchitecture)": the bare words name a person first, so the item may not claim them.
const BRACKET_TITLE = /\s*\(([^()]+)\)\s*$/;
const personTitles = new Set();
{
  const bases = [...new Set([...entities.values()].filter((e) => BRACKET_TITLE.test(e.title)).map((e) => e.title.replace(BRACKET_TITLE, '')))]
    .filter((t) => t.includes(' '))
    .sort();
  for (let i = 0; i < bases.length; i += 200) {
    const vals = bases.slice(i, i + 200).map((t) => `${JSON.stringify(t)}@en`).join(' ');
    const rows = await sparql(`SELECT ?t WHERE {
  VALUES ?t { ${vals} }
  ?a schema:name ?t; schema:isPartOf <https://en.wikipedia.org/>; schema:about ?i. ?i wdt:P31 wd:Q5.
}`);
    for (const r of rows) personTitles.add(r.t.value);
  }
  console.log(`  bracketed titles checked: ${bases.length}; bare title is a person: ${personTitles.size}`);
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
const drops = { personTitle: 0, short: 0, long: 0, noLetter: 0, digits: 0, common: 0, commonPhrase: 0, notPrimary: 0, singleAlias: 0, singlePerson: 0, ambiguous: 0, budget: 0 };
/** name -> Map(label -> best sitelinks) and name -> best { label, sl, rel } */
const claims = new Map();
function claim(name, e, kind) {
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
  if (bracketed && personTitles.has(e.title.replace(BRACKET, '')) && name === normName(e.title.replace(BRACKET, ''))) {
    return void drops.personTitle++;
  }
  if (words.length === 1 && COMMON.has(name)) return void drops.common++;
  if (oneCore) {
    // One word (or "the" + one word): only when Wikipedia gives this item the bare title, so it is the primary topic
    // ("The Wire" stays; "Halo (franchise)", "The Office (American TV series)" do not).
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
  let c = claims.get(name);
  if (!c) claims.set(name, (c = new Map()));
  const prev = c.get(e.labelId);
  const bar = GROUP_BAR[e.group];
  const owns = primary && kind === 'label';
  // A label from an item whose own Wikipedia title is bracketed ("Cowboy Bebop (2021 TV series)") is no stronger
  // than an alias against the item that owns the bare title.
  const named = kind === 'label' && !bracketed;
  if (!prev) c.set(e.labelId, { sl: e.sl, rel: e.sl / bar, owns, named });
  else {
    if (e.sl > prev.sl) Object.assign(prev, { sl: e.sl, rel: e.sl / bar });
    prev.owns ||= owns;
    prev.named ||= named;
  }
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
      claim(n, e, kind);
    }
  };
  for (const l of e.labels) offer(l, 'label');
  if (!BRACKET.test(e.title)) offer(e.title, 'label');
  for (const a of e.aliases) offer(a, 'alias');
}
const kept = [];
for (const [name, c] of claims) {
  const ranked = [...c.entries()].sort((a, b) => b[1].sl - a[1].sl);
  const [best, second] = ranked;
  // The item Wikipedia gives the bare title to keeps it against other labels that only claim it by an alias or by the
  // label of a bracketed article ("The Shawshank Redemption" the film, against the novella's alias).
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
console.log(`  people dropped: other fame (actor/politician/...) ${personDrops.otherFame}, music/sport tie or other side ${personDrops.split}`);
console.log(`  names dropped: ${Object.entries(drops).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  per label: ${labels.map((l) => `${l} ${byLabel.get(l).length}`).join(', ')}`);
console.log(`  SCOWL common words: ${COMMON.size} (sha256 ${scowlSha})`);
console.log(`  wrote ${OUT}: ${Buffer.byteLength(text)} bytes, sha256 ${createHash('sha256').update(text).digest('hex')}`);
