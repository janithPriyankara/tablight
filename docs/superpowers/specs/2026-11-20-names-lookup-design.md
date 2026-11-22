# Name knowledge and opt-in look-up — design

Date: 2026-11-20. Branch: `accuracy-90`. Owner request: "plan all and implement all" (both options below), after
asking for the model to "look up" what bare names mean, provided it is "bulletproof" for privacy and security.

## Why

The model knows topics, not names. On the owner's real export, the misses are bare names: Google searches for
"jack ryan", "Doom at Your Service", "The Counsler", "i7 8700", "ACS770KCB-150B", and pages such as "NVIDIA". A
person (or a search engine) would know these are a TV series, a drama, a film, a CPU, a current sensor, a chip
company. Tablight should know too, without weakening its privacy promise for anyone who doesn't opt in.

## Goals

1. **Offline name knowledge (always on, no network).** A compact list of well-known names with their Tablight
   label, built from Wikidata (CC0), plus part-number patterns. Bare-name searches and name-only titles get a group.
2. **Opt-in look-up (user-clicked, one tab at a time).** For an Unsorted tab, a "Look it up" action sends one
   cleaned text, shown to and editable by the user before anything is sent, to Wikidata's public search API, and
   offers "Move to <group>" from the answer. Never automatic, never in the background.
3. **An honest number.** A fresh sealed benchmark (v2), written before the name list is built and scored once at
   the end, so docs/accuracy.md describes what ships.

## Non-goals

- No search-engine scraping (Google/Bing terms), no paid API, no API key, no Tablight server.
- No automatic or background look-ups, no batch look-ups, no look-up of page content or URLs.
- No change to the model, the head or its thresholds.
- Misc/Other auto-filing and 2-tab suggestions stay out (separate owner decisions).

## Anti-goals (a failure even if it works)

- Any network request the user did not click for and see the exact text of.
- Any text sent that the user did not see, including the URL, cookies, a referrer or an identifier.
- A name list that files ordinary words ("Friends", "Up", "Her") or a colleague's name into a topic.
- A user's correction being overridden by the name list.

## Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| Search each title online automatically | Leaks every title to a third party; breaks the promise; ToS/cost issues | Rejected |
| Offline Wikidata name list | Private and free; limited to well-known names; size budget | **Chosen (part 1)** |
| User-clicked look-up via Wikidata API | Sends one approved text; small, honest privacy cost; needs CSP change | **Chosen (part 2), off unless clicked** |
| Our own proxy server with a search API key | A server holding everyone's queries is the main attack target | Rejected |
| Infer from neighbouring tabs | Already exists (neighbour step); weak for bare names | Unchanged |

## Part 1: offline name list

- **Source:** Wikidata via its public SPARQL endpoint at build time only (CC0; credit in third-party notices).
  A build script `scripts/names/build.mjs` writes `public/names/names.txt` (committed, checksummed like the model).
- **Classes → labels** (the implementer picks QIDs and records them in the script):
  tv (TV series, miniseries, web series, TV dramas), movies (films), games (video games), music (bands, musical
  groups, albums, musicians), anime (anime series, manga), books (novels, book series), cars (automobile models,
  car makers), sports (sports clubs, leagues), hardware (CPU/GPU/microcontroller/SBC models, semiconductor and
  electronics component makers). Persons only for musicians (music) and athletes (sports), at a higher popularity bar.
- **Popularity:** rank by Wikidata sitelink count; keep the best-known entities per class within the size budget.
- **Ambiguity rules (build time):** normalise names (lowercase, strip diacritics and punctuation, collapse spaces);
  drop names shorter than 4 characters; drop single-word names that are common English words (build-time word list,
  not shipped, licence recorded); drop a name claimed by two labels unless one label's best entity has ≥ 5× the
  sitelinks of the other's; English labels and English aliases only.
- **Size:** `names.txt` ≤ 1,500,000 bytes; the 55,000,000-byte package limit must still pass.
- **Format:** plain text, one section per label (`#tv` line, then one name per line), loaded once, lazily, by the
  background worker via `chrome.runtime.getURL` into a `Map<string, label>`.
- **Matching (`src/classify/names.ts`):** compute the *core* of a tab:
  - search-engine result pages (Google, Bing, DuckDuckGo, Yahoo, Brave, Ecosia, Startpage): the query parameter,
    computed locally;
  - Wikipedia pages: the title minus " - Wikipedia"; a disambiguator in brackets ("(TV series)", "(film)",
    "(video game)", "(band)", "(company)", "(microcontroller)" …) decides the label directly;
  - other pages: the title minus the site suffix.
  Then strip noise words at either end ("season 2", "episode 5", "cast", "trailer", "imdb", "wiki", "review",
  "ending explained", "full movie", "ost", "datasheet", "price", "specs", "release date", years) and look the
  normalised core up exactly (also without a leading "the"). Only an exact whole-core match counts; a name inside
  a longer sentence does not.
- **Part numbers:** explicit patterns for CPU/GPU models (Intel Core iN-NNNN, Ryzen, RTX/GTX/RX), common MCU and
  SBC families (ESP32/ESP8266, STM32, ATmega/ATtiny, RP2040, nRF52, Raspberry Pi, Arduino), and a generic
  manufacturer-part-number shape (letters+digits, ≥ 6 chars, at least two digit runs or a dash) that counts only on
  search-engine queries, datasheet/distributor sites (Digi-Key, Mouser, LCSC, Octopart, AllDatasheet, Farnell,
  ti.com, st.com, microchip.com, infineon.com, nxp.com) or titles containing "datasheet". All → hardware.
- **Place in the pipeline:** rule → user-taught exemplars → **name** → head → neighbours → YouTube bar → Videos.
  The name step only files into an existing group, `by: 'name'`; when the group doesn't exist it sets `want` like
  the head does. A user's taught examples keep winning.

## Part 2: opt-in look-up

- **Where:** a "Look it up" action on Unsorted rows in the dashboard and side panel. A setting
  "Show the Look it up button" (default on) hides it entirely. Nothing is ever sent without the dialog below.
- **The dialog, every time:** "Tablight will send this text to Wikidata (Wikimedia Foundation) and nothing else:"
  followed by an editable text box with the cleaned text, a note of what is never sent (the address, other tabs,
  cookies, any ID), a link to Wikimedia's privacy policy, and Look up / Cancel.
- **Cleaning (`src/shared/lookup-text.ts`, pure):** start from the tab's core (Part 1); remove emails, URLs and
  host names, @handles, phone numbers, digit runs ≥ 6, hex/base64-like tokens ≥ 12 chars; keep ≤ 8 words and
  ≤ 80 characters. **Refuse** (no button) when the URL is not http(s), the host is local or private (localhost,
  `.local`, `.internal`, `.lan`, single-label hosts, private IP ranges), or the core or host contains a sensitive
  term (banking, payments, invoices, passwords/sign-in/account, medical/clinic/diagnosis/pregnancy, legal/divorce,
  salary/payslip/tax). The user can still edit the text in the dialog, never the refusal.
- **Request:** from the extension page, `GET https://www.wikidata.org/w/api.php?action=wbsearchentities&search=<text>&language=en&uselang=en&type=item&limit=5&format=json&origin=*`,
  `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, `cache: 'no-store'`, 10 s timeout. No host permission is
  needed (Wikidata serves anonymous CORS); the CSP `connect-src` gains exactly `https://www.wikidata.org`.
- **Answer handling:** the response is untrusted data. Parse JSON defensively, keep only `label` and
  `description` strings (capped at 200 chars), render as plain text (no HTML), map each description to a label with
  a keyword table (`src/classify/describe.ts`: "television series" → tv, "film" → movies, "video game" → games,
  "band"/"singer"/"album" → music, "manga"/"anime" → anime, "novel" → books, "semiconductor"/"microcontroller"/
  "integrated circuit"/"processor"/"graphics card" → hardware, "automobile"/"car model" → cars, "football club" →
  sports …), falling back to the head on "<label> — <description>" through a background RPC. Show up to 3 hits,
  each with its group; "Move to <group>" uses the existing user move (so it also teaches the group), or creates the
  starter group first when it doesn't exist.
- **Cache:** answers cached locally (chrome.storage.local, ≤ 500 entries, never synced or exported, removed by
  "Delete all data"), so the same text is never sent twice.
- **Errors:** offline, timeout, HTTP error or bad JSON → a plain message, nothing moved.

## Promise and documents

- README, `public/privacy.html`, `store/listing.md` and docs/accuracy.md say: Tablight makes no network requests
  unless you click Look it up and confirm; then only the text you saw goes to Wikidata; the extension has no host
  permissions and no servers. The store's privacy disclosure lists "website content: the text you choose to look
  up", Limited Use.
- `scripts/verify-release.mjs`: the pinned CSP gains `https://www.wikidata.org` in `connect-src`; the URL allowlist
  allows that one API URL, in that one file. The names file is checksummed.
- e2e: the existing "no network requests" run stays as is (default flows never fetch). A new e2e test routes
  Wikidata to a fixture, clicks Look it up and asserts exactly one request, to that API, with the shown text, no
  Cookie and no Referer, and that the tab moved after "Move to".

## Benchmark v2

- Written **before** the name list is built, with the same BRIEF.md and labelling process as v1 (fresh writers, an
  independent labeller, an adjudicator), 20 new personas (`c01`–`c20`), sealed in `tests/benchmark/v2/` with its
  SHA-256 pinned and the leakage check extended to it. Nobody reads its rows.
- Scored once at the end (`npm run test:benchmark` now scores v2; v1 stays as the record of the first figure).
  docs/accuracy.md reports v2 with the same table, and keeps v1 as history. The look-up is user-driven and not
  counted.

## Left to the builder

QIDs and per-class popularity bars, the exact noise-word and sensitive-term lists, the keyword table, the common-
word list source (recorded, not shipped), UI copy beyond the dialog sentence above, and test fixtures. A dev set
for names (`tests/quality/names-dev.json`, written by the builder, not blind) guards precision ≥ 95% of the name
step; `npm run test:quality` must not regress.
