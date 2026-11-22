# Name Knowledge and Opt-in Look-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tablight recognises well-known names (shows, films, games, chips, parts…) offline, offers a user-clicked Wikidata look-up for Unsorted tabs, and re-measures accuracy on a fresh sealed benchmark.

**Architecture:** A build-time Wikidata extract (`public/names/names.txt`) is loaded lazily by the background worker into a module-level index; `pickGroup` gains a `name` step after user exemplars. The look-up runs only in extension pages after a confirm dialog showing the exact text; it calls Wikidata's public CORS API with no credentials and maps descriptions to labels. Benchmark v2 is sealed first and scored once last.

**Tech Stack:** TypeScript, React, Vitest, Playwright, Chrome MV3, Node build scripts, Wikidata SPARQL (build time) and `wbsearchentities` (runtime, opt-in).

**Spec:** docs/superpowers/specs/2026-11-20-names-lookup-design.md

## Global Constraints

- No network request ever happens without the user clicking Look it up and confirming the dialog that shows the exact text.
- Only `https://www.wikidata.org/w/api.php` may be fetched; `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `cache: 'no-store'`, 10 s timeout. No host permissions are added.
- CSP `connect-src` becomes exactly `'self' https://www.wikidata.org`; every other CSP directive is unchanged.
- `public/names/names.txt` ≤ 1,500,000 bytes; the package stays under 55,000,000 bytes.
- Pipeline order: rule → exemplar → name → head → neighbour → YouTube bar → Videos. The name step files only into existing groups, else sets `want`.
- Never read page content. Real user tabs are never training or names-tuning data (the owner's export may be used for diagnosis only, printing aggregates).
- Never open rows of tests/quality/holdout*.json, youtube-messy.json, sessions.json, tests/benchmark/benchmark.json or tests/benchmark/v2/benchmark.json.
- `BENCHMARK=1` / `npm run test:benchmark` runs exactly once, in Task 9.
- Commits: scoped `git add` (never `-A`), separate `-m` paragraphs, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No pushes.
- Response text from Wikidata is untrusted: plain-text rendering only, strings capped at 200 chars.

## Review Focus

1. A bare common word ("friends", "up", "her", "cars") or a person's name in a non-search title must not be filed by the name step → Task 2 test `common words and sentences never match`.
2. A tab the user already moved (exemplar) must stay where the user taught, even when the name list disagrees → Task 4 test `exemplar beats name`.
3. Names not yet loaded (worker just woke) must not throw and must not file anything by name → Task 4 test `pickGroup without names loaded`.
4. Look-up text for a sign-in, bank, clinic or localhost tab must be refused, and emails/IDs must never survive cleaning → Task 5 tests.
5. A malicious or malformed Wikidata reply (HTML in description, huge strings, wrong shape, non-200) must move nothing and render as text → Task 6 tests `untrusted reply`.

---

### Task 1: Benchmark v2, sealed before any names work

Controller-orchestrated (writers, independent labeller and adjudicator are separate fresh agents that see only BRIEF.md, training/LABELING.md and their own inputs; nobody else reads rows).

**Files:**
- Create: `tests/benchmark/v2/benchmark.json`, `tests/benchmark/v2/SEAL.md`
- Modify: `tests/unit/benchmark-seal.test.ts` (check v1 and v2), `tests/benchmark/benchmark.test.ts` (score v2 only), `package.json` (`test:benchmark` unchanged command, scoring v2)

- [ ] Step 1: Writers produce 20 personas `c01`–`c20`, 50–70 tabs each, per tests/benchmark/BRIEF.md, rows `{title,url,group,persona}` like v1. Personas must differ from v1's b01–b20.
- [ ] Step 2: Independent labeller labels from title+url only; adjudicator settles disagreements, adds `also` where both fit. Record agreement counts.
- [ ] Step 3: Drop rows whose normalized title, URL or near-title matches any training/*.json or tests/quality/*.json row (same rules as v1).
- [ ] Step 4: Write SEAL.md (counts, agreement, SHA-256). Extend benchmark-seal.test.ts: SHA test and leakage test run for both `tests/benchmark` and `tests/benchmark/v2`, `KNOWN_NEAR = 0` for v2.
- [ ] Step 5: Point benchmark.test.ts at `v2/benchmark.json`; v1 file stays, unscored.
- [ ] Step 6: `npx vitest run tests/unit/benchmark-seal.test.ts` PASS; commit `test: seal benchmark v2 before the name list`.

### Task 2: Name matcher and part-number patterns

**Files:**
- Create: `src/classify/names.ts`, `tests/unit/names.test.ts`

**Interfaces:**
- Produces:
  - `type NameIndex = ReadonlyMap<string, string>` (normalized name → label id)
  - `parseNames(text: string): NameIndex` — format: `#<label>` section lines, then one normalized name per line; blank lines ignored.
  - `normName(s: string): string` — lowercase, NFKD diacritics stripped, non-letter/digit → space, collapsed, trimmed.
  - `tabCore(url: string, title: string): { core: string; source: 'search' | 'wikipedia' | 'title' } | null` — search query from Google/Bing/DuckDuckGo/Yahoo/Brave/Ecosia/Startpage (`q`/`p` params); Wikipedia title minus " - Wikipedia"; else title minus site suffix; noise words trimmed at both ends (spec list plus 4-digit years); returns normalized core, null when empty.
  - `WIKI_DISAMBIG: Record<string,string>` and `nameLabel(url: string, title: string, index: NameIndex | null): string | null` — order: Wikipedia disambiguator → part-number patterns → exact index lookup of core, then core without leading "the ".
  - `partNumberLabel(core: string, url: string, source): 'hardware' | null`.

- [ ] Step 1: Tests (fixture index via `parseNames('#tv\njack ryan\n#movies\nthe admiral\n#hardware\nnvidia\n')`):
  - `nameLabel('https://www.google.com/search?q=jack+ryan','jack ryan - Google Search', idx) === 'tv'`
  - `nameLabel('https://www.bing.com/search?q=The+Admiral', 'The Admiral - Search', idx) === 'movies'`; `'admiral'` also matches via leading-"the" drop only in the other direction (index "the admiral", query "admiral" → null).
  - `nameLabel('https://en.wikipedia.org/wiki/Foo_(TV_series)','Foo (TV series) - Wikipedia', null) === 'tv'`; `(video game)` → games; `(film)` → movies; `(band)` → music.
  - `jack ryan season 2 cast` search → tv (noise trimmed); `NVIDIA` page titled `NVIDIA` on nvidia.com → hardware.
  - Part numbers: `i7 8700`, `i7-8700K`, `Ryzen 5 5600X`, `RTX 4090`, `ESP32-S3`, `STM32F103C8T6`, `ATmega328P`, `RP2040` → hardware anywhere; `ACS770KCB-150B` → hardware on a google search and on mouser.com, null on a plain blog title.
  - `common words and sentences never match`: index containing `friends`, `up`; titles `Friends`, `up` on non-search pages → null only when the index lacks them (index builder drops them, Task 3); sentence `how jack ryan changed spy fiction` → null; `ERR_CONNECTION_REFUSED`, `COVID19`, `B0CXYZ1234` on non-search pages → null.
  - `nameLabel(..., null)` with no disambiguator/part number → null.
- [ ] Step 2: Run `npx vitest run tests/unit/names.test.ts` — FAIL (module missing).
- [ ] Step 3: Implement in `src/classify/names.ts` (pure, no chrome APIs).
- [ ] Step 4: Tests PASS; `npm run lint` clean; commit `feat: name matcher and part-number patterns`.

### Task 3: Build the Wikidata name list

**Files:**
- Create: `scripts/names/build.mjs`, `scripts/names/README.md`, `public/names/names.txt`, `tests/quality/names-dev.json`, `tests/unit/names-file.test.ts`
- Modify: `scripts/verify-release.mjs` (names.txt SHA-256 pinned + 1,500,000-byte cap), `scripts/third-party-notices.mjs` (Wikidata CC0 credit), `package.json` (`"names:build": "node scripts/names/build.mjs"`)

**Interfaces:**
- Consumes: `normName` from Task 2 (import the logic or mirror it exactly and test equality on 50 strings).
- Produces: `public/names/names.txt` in the `parseNames` format; `NAMES_SHA256` constant in verify-release.

- [ ] Step 1: `names-file.test.ts`: file exists, ≤ 1,500,000 bytes, every section label is a starter group id (seeds.ts), every name equals `normName(name)`, length ≥ 4, no name appears in two sections, and none of `friends up her cars home news games music` (the common-word filter) is present.
- [ ] Step 2: Script: per-class SPARQL queries (classes/QIDs and sitelink bars recorded in the script, per spec Part 1), English labels + aliases, ambiguity rules (≥5× sitelinks dominance, common-word filter from a build-time list whose source and licence are recorded in README, not shipped), fills the budget best-known first. Polite User-Agent with a generic client name, retries with backoff, caches raw responses under the scratchpad (not committed).
- [ ] Step 3: Run `npm run names:build`; commit the output.
- [ ] Step 4: `tests/quality/names-dev.json`: ~150 builder-written rows `{title,url,group}` (bare-name searches, Wikipedia pages, part searches, and ~40 negatives labelled `other`/non-name). Not blind; records it in the file's header README note.
- [ ] Step 5: `npm test` and `npm run build` PASS (verify-release prints names checksum and size); commit `feat: offline name list from Wikidata`.

### Task 4: Wire the name step into the pipeline

**Files:**
- Modify: `src/shared/types.ts` (`PlacedBy` adds `'name'`), `src/classify/assign.ts` (split exemplar from head: `exemplarPick(vec, groups, head): { groupId: string; score: number } | null`; `classify` keeps its behaviour), `src/classify/pick.ts` (name step), `src/classify/names.ts` (`setNameIndex(i: NameIndex | null): void`, `currentNameIndex(): NameIndex | null`), `src/background/tab-index.ts` (await `loadNameIndex()` before a batch), `tests/quality/sessions-sim.ts` (load names.txt via fs + `setNameIndex`), UI copy for `placedBy: 'name'` if any UI lists reasons.
- Create: `src/background/names-load.ts` (`loadNameIndex(): Promise<NameIndex | null>` — fetch `chrome.runtime.getURL('names/names.txt')` once, memoise, null on failure, retry next batch), `tests/quality/names-dev.test.ts`
- Test: `tests/unit/pick.test.ts`

- [ ] Step 1: pick.test.ts tests: `name step files a bare-name search into tv when tv exists` (by `'name'`); `name step sets want when the group is missing`; `exemplar beats name` (group taught with that vector → by `'exemplar'`); `rule beats name`; `pickGroup without names loaded` (index null → unchanged behaviour, no throw).
- [ ] Step 2: names-dev.test.ts: name-step precision on names-dev.json ≥ 95% and recall reported; prints aggregates only.
- [ ] Step 3: Implement; `NOT_EVIDENCE` leaves `'name'` as evidence.
- [ ] Step 4: `npm test`, `npm run test:quality` — every existing quality figure ≥ its value before this task (record before/after in the report). Diagnostic only: count how many of the owner's export tabs (`~/Downloads/tablight-2026-11-20.json`) the name step files and into which labels, aggregates printed, no rows committed, test file deleted afterwards.
- [ ] Step 5: commit `feat: name step after taught examples`.

### Task 5: Look-up text cleaning and description mapping (pure)

**Files:**
- Create: `src/shared/lookup-text.ts`, `src/classify/describe.ts`, `tests/unit/lookup-text.test.ts`, `tests/unit/describe.test.ts`

**Interfaces:**
- Consumes: `tabCore` (Task 2).
- Produces: `lookupText(url: string, title: string): { text: string } | { refused: 'local' | 'sensitive' | 'scheme' | 'empty' }`; `cleanLookupText(s: string): string` (also applied to the user's edit before sending); `describeLabel(description: string): string | null`.

- [ ] Step 1: Tests:
  - `lookupText('https://www.google.com/search?q=jack+ryan','jack ryan - Google Search')` → `{text:'jack ryan'}`.
  - refused `local`: `http://localhost:3000/x`, `http://192.168.1.4/`, `http://jenkins.internal/job`, `http://nas/`, `http://printer.local/`.
  - refused `sensitive`: titles with `Sign in`, `password`, `Bank`, `Invoice`, `clinic`, `diagnosis`, `payslip`; host `online.hsbc.com` style containing `bank`.
  - refused `scheme`: `chrome://settings`, `file:///x`.
  - `cleanLookupText('mail me at a.b@c.com about ACS770 order 123456789 token 9f8e7d6c5b4a3f2e1d0c')` → contains `ACS770`, no `@`, no `123456789`, no hex token; ≤ 8 words, ≤ 80 chars.
  - describe: `'2019 South Korean television series'`→tv, `'1999 film directed by…'`→movies, `'2016 video game'`→games, `'American semiconductor company'`→hardware, `'English rock band'`→music, `'Japanese manga series'`→anime, `'novel by…'`→books, `'automobile model'`→cars, `'association football club'`→sports, `'Wikimedia disambiguation page'`→null, `'human settlement'`→null.
- [ ] Step 2: FAIL, implement, PASS; commit `feat: look-up text cleaning and description labels`.

### Task 6: Look-up client, cache, RPC and release checks

**Files:**
- Create: `src/ui/common/lookup.ts`, `tests/unit/lookup.test.ts`
- Modify: `manifest.config.ts` (CSP), `scripts/verify-release.mjs` (pinned CSP; URL allowlist entry for `https://www.wikidata.org/w/api.php` in `src/ui/common/lookup.ts` only), `src/shared/rpc.ts` (`{ t: 'labelForText'; text: string }` → `{ label: string | null; score: number }`), background handler (embed + `headTop`, label null below head.threshold or `other`), `src/background/reset.ts` (remove `lookupCache`), `tests/unit/manifest.test.ts`

**Interfaces:**
- Produces: `interface LookupHit { label: string; description: string; group: string | null }`; `lookUp(text: string, deps?: { fetch?: typeof fetch; now?: () => number; labelForText?: (t: string) => Promise<string | null> }): Promise<{ hits: LookupHit[] } | { error: 'offline' | 'timeout' | 'http' | 'bad-reply' }>` — cleans text, checks cache (`chrome.storage.local` key `lookupCache`, ≤ 500 entries, oldest evicted), fetches, maps via `describeLabel` then `labelForText(label + ' — ' + description)`.

- [ ] Step 1: Tests with a fake fetch: exact URL (`action=wbsearchentities&search=<encoded>&language=en&uselang=en&type=item&limit=5&format=json&origin=*`) and init (`credentials:'omit'`, `referrerPolicy:'no-referrer'`, `cache:'no-store'`, `method:'GET'`, an AbortSignal); second call for the same text uses the cache (fetch called once); cache cap 500; `untrusted reply`: non-200 → `http`, non-JSON → `bad-reply`, `search` not an array → `bad-reply`, `<img onerror>` description kept as literal text, 10 kB description truncated to 200 chars; timeout → `timeout`; fetch TypeError → `offline`.
- [ ] Step 2: manifest.test.ts asserts the new CSP string and that `host_permissions`/`optional_host_permissions` are absent.
- [ ] Step 3: Implement; `npm test`, `npm run build` (verify-release passes with the new allowlist) PASS; commit `feat: opt-in Wikidata look-up client`.

### Task 7: Look-up UI and setting

**Files:**
- Modify: `src/shared/types.ts` (`Settings.lookupButton: boolean`, default `true`), `src/ui/common/ItemRow.tsx` (action on Unsorted rows when `lookupText` is not refused and the setting is on), `src/ui/dashboard/Settings.tsx` (toggle "Show the Look it up button"), side panel row actions.
- Create: `src/ui/common/LookupDialog.tsx`, `tests/unit/ui-lookup.test.tsx`, `tests/e2e/lookup.spec.ts`

- [ ] Step 1: Unit tests: button absent for grouped rows, refused rows and when the setting is off; dialog shows the sentence "Tablight will send this text to Wikidata (Wikimedia Foundation) and nothing else:", an editable box with the cleaned text, the never-sent note, a Wikimedia privacy-policy link; Cancel sends nothing (fetch spy uncalled); Look up calls `lookUp` with the edited (re-cleaned) text; hits render as text; "Move to TV Series" sends `moveItems`; a missing starter group is created first (`interests` RPC with that id, or the existing group-creation path the implementer finds), then moved.
- [ ] Step 2: e2e: existing no-network test still passes untouched; `lookup.spec.ts` routes `https://www.wikidata.org/**` to a fixture JSON, opens a Google-search fixture tab left Unsorted, clicks Look it up → Look up; asserts exactly one request to `www.wikidata.org/w/api.php`, `search=` equals the shown text, no `cookie` and no `referer` request header; Move to → tab is in the group.
- [ ] Step 3: Implement, `npm test`, `npm run build`, `npm run test:e2e` PASS; commit `feat: Look it up button and dialog`.

### Task 8: Promise, privacy and store text

**Files:**
- Modify: `README.md`, `public/privacy.html`, `store/listing.md`, `docs/accuracy.md` (method section: name list step; look-up not counted; result section left for Task 9)

- [ ] Step 1: Replace "makes no network requests" claims with: no network requests unless you click Look it up and confirm; then only the text you saw goes to Wikidata (Wikimedia Foundation); no host permissions, no servers, no accounts, no analytics. Store listing: data disclosure "Website content — only the text you choose to look up", Limited Use statement, CSP change noted in the reviewer notes. Name list credited (Wikidata, CC0).
- [ ] Step 2: `grep -rn -e "no network" -e "network request" README.md public store docs src/ui` shows no stale absolute claim; `npm run build` PASS; commit `docs: say exactly when Tablight uses the network`.

### Task 9: Score benchmark v2 once and report

**Files:**
- Modify: `docs/accuracy.md`, `tests/benchmark/v2/SEAL.md` (scored date), README if the headline figure is quoted

- [ ] Step 1: `npm run test:benchmark` exactly once (verbose reporter, output saved to the SDD workspace).
- [ ] Step 2: docs/accuracy.md: v2 result table, per-label recall, the name step's share of placements if printed, v1 kept as "first measurement"; store wording updated with the v2 figures and coverage, stated plainly against the 90% target.
- [ ] Step 3: commit `docs: accuracy on benchmark v2`.
