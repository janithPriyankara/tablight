# Grouping by Meaning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tabs land where a person would put them: unsure tabs follow their closest grouped tabs, dramas go to TV,
only confident guesses grow groups, `videos` means "no subject", and the best embedding model that fits is shipped.

**Architecture:** `pickGroup` (src/classify/pick.ts) gains a neighbour step fed by a pool of the user's grouped tabs
(built in src/background/tab-index.ts from cached vectors) and a careful `want`. rules.ts gains drama rules. grow.ts
needs 3 wants. New blind synthetic data trains the head (scripts/train-head.mjs) and tunes/gates the neighbour step
(tests/quality). A model comparison reuses train-head's MODEL_ID / MODEL_PATH / OUT and accuracy.test's HEAD_PATH /
MODEL_PATH overrides.

**Tech Stack:** TypeScript, Preact MV3 extension, Vitest, @huggingface/transformers (ONNX, q8), IndexedDB (idb).

**Spec:** docs/superpowers/specs/2026-11-19-semantic-grouping-design.md

## Global Constraints

- Never read page content; titles and URLs only.
- Training and tuning data is synthetic and written blind (writers never see src/, tests/, or the owner's export).
- Never open the rows of tests/quality/holdout.json, holdout2.json, holdout3.json, youtube-messy.json or the new
  tests/quality/sessions.json; tests print aggregates only for them.
- The owner's export (~/Downloads/tablight-2026-11-19 (1).json) is used only in Task 9, for counts, never for tuning.
- User placements (`groupSource: 'user'`) never change automatically.
- A neighbour placement never counts as evidence for another neighbour placement.
- Gates kept: holdout ≥ 85%, holdout2 ≥ 82%, `other` auto-assigned ≤ 35%, holdout3 ≥ 82% and each on-demand label
  ≥ 70%, YouTube no-topic in Videos ≥ 70%, youtube-topics and youtube-messy topic rates no lower than today's floors.
- Model swap only if the winner gains ≥ 3 points on each honest set (holdout2, youtube-messy, sessions) and embedding
  200 tabs takes ≤ 2× bge-small's time.
- Local-only item fields (like `want`) are never synced or exported and never bump `updatedAt`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; use separate `-m` flags (heredocs lose
  blank lines here).
- Pushing main is the owner's job (a hook blocks it); no release without the owner's go-ahead.

## Review Focus

- A tab whose two nearest grouped tabs are themselves near-duplicates of each other (same page twice) must not count
  as two independent votes: neighbours with the same `normUrl` count once.
- A profile with thousands of grouped tabs: the pool is capped (NEIGHBOUR_POOL_MAX, most recently active first) and a
  unit test bounds the cost.
- Vectors of a different length than the tab's (a pool built across a model change) are skipped, never crash.
- Regroup: the item being re-picked is excluded from its own pool.
- An auto tab placed by a neighbour later gets a confident head result (title changed): it moves and its placement
  kind updates.

---

### Task 1: Careful growth

**Files:**
- Modify: `src/classify/pick.ts` (want bar), `src/background/grow.ts` (GROW_MIN)
- Test: `tests/unit/pick.test.ts`, `tests/unit/grow.test.ts`

**Interfaces:**
- Produces: `GROW_MIN = 3`; `pickGroup` sets `want` only when the head's top score ≥ `head.threshold` (pages and
  videos alike). Placement rules are unchanged: a video still joins an *existing* topic group at YOUTUBE_THRESHOLD.

- [ ] **Step 1: Failing tests.** In pick.test.ts: a YouTube video whose top label scores between YOUTUBE_THRESHOLD and
  `head.threshold`, with no group for that label but a Videos group → `{ groupId: 'videos', want: null }`; the same
  video scoring ≥ `head.threshold` → `want: <label>`. In grow.test.ts: two wanting tabs → no group; three → group
  created (update existing GROW_MIN-2 tests to 3).
- [ ] **Step 2:** `npx vitest run tests/unit/pick.test.ts tests/unit/grow.test.ts` → the new cases FAIL.
- [ ] **Step 3:** Implement: in `pickGroup`, keep `label` (at `bar`) for placement and compute
  `wanted = top.score >= head.threshold ? label : null` for the returned `want`. Set `GROW_MIN = 3`; update its doc.
- [ ] **Step 4:** `npm test` → PASS (fix any other test that assumed 2 or a weak want, e.g. groups.test.ts
  "topics that have no group yet" — give it 3 tabs and a confident vector).
- [ ] **Step 5:** Commit `fix: only confident guesses grow a group, and it takes three tabs`.

### Task 2: Drama rules

**Files:**
- Modify: `src/classify/rules.ts`
- Test: `tests/unit/classify.test.ts` (where `ruleGroup` is tested; create a `describe('drama rules')`)

**Interfaces:**
- Produces: `ruleGroup(url, title)` returns `'tv'` / `'movies'` for drama sites and `'tv'` for drama-hashtag YouTube
  videos. (`pickGroup` already applies a rule only when its group exists.)

- [ ] **Step 1: Failing tests** (`ruleGroup` results):
  - `https://kisskh.co/Drama/Fight-For-My-Way/Episode-3?id=1`, "Fight For My Way Episode 3" → `'tv'`
  - `https://kisskh.co/Drama/Some-Film?id=2`, "Some Film (2019) Full Movie" → `'movies'`
  - `https://www.viki.com/tv/123-x`, "Watch X" → `'tv'`; `https://mydramalist.com/123-x`, "X - MyDramaList" → `'tv'`
  - `https://www.youtube.com/shorts/abc`, "He caught her… #cdrama #shorts - YouTube" → `'tv'`
  - `https://www.youtube.com/watch?v=abc`, "Best scenes #kdramaedit - YouTube" → `'tv'`
  - `https://www.youtube.com/watch?v=abc`, "Drama in the parliament today - YouTube" → `null` (the word alone is not a tag)
  - `https://kisskh.co/`, "KissKH" → `'tv'` (the whole site is a drama site)
- [ ] **Step 2:** `npx vitest run tests/unit/classify.test.ts` → FAIL.
- [ ] **Step 3:** Implement `drama(host, path, title): string | null` called in `ruleGroup` before `byHost`:
  a `DRAMA_HOSTS` list (kisskh and its known mirrors as host patterns, dramacool-style hosts, viki.com, wetv.vip,
  iq.com, mydramalist.com, asianc-style hosts — from public knowledge only) → `/\b(?:full\s+movie|the\s+movie)\b/i` in
  the title → `'movies'`, else `'tv'`. For youtube.com watch/shorts URLs: a title tag matching
  `/#(?:k|c|j|thai|tw|asian)?drama(?:edit|s|clips?)?\b/i` → `'tv'`. Doc comment says why (the model lacks drama
  world knowledge; spec §2).
- [ ] **Step 4:** `npm test` and `npm run test:quality` → PASS (gates unchanged or better; print the numbers).
- [ ] **Step 5:** Commit `feat: drama sites and drama-tagged videos go to TV Series`.

### Task 3: Sessions data (controller task: blind writers)

The controller runs this task itself, because it dispatches writer agents (implementers may not).

**Files:**
- Create: `training/sessions-tune.json`, `tests/quality/sessions.json`, `training/SESSIONS.md` (the brief given to
  writers, committed so the data can be reproduced)
- Modify: `tests/quality/README.md` (describe both files)

**Interfaces:**
- Produces: JSON array of `{ person: string, title: string, url: string, group: string }`, `group` a seed id from
  src/classify/seeds.ts or `other`. Each person 30–60 tabs clustered around 3–6 personal interests with realistic
  repetition (many pages of the same board, show, framework, site), messy titles, some YouTube videos, ~10% `other`.

- [ ] **Step 1:** Write training/SESSIONS.md: the format above, the label list with one-line meanings copied from
  training/LABELING.md, the YouTube rule, and 12 persona sketches for the tune file and 12 different ones for the
  holdout (e.g. hardware maker, K-drama watcher, backend developer, ML student, home cook, parent, car buyer,
  photographer, job seeker, anime fan, finance-curious student, traveller planning a trip). No example rows from any
  existing file.
- [ ] **Step 2:** Dispatch 4 writer agents (model: sonnet), each given only SESSIONS.md and 6 personas, told not to
  read the repo beyond SESSIONS.md and LABELING.md. Two write the tune file's halves, two the holdout's halves.
- [ ] **Step 3:** Merge halves; validate with a script: valid JSON, known labels, http(s) URLs, 30–60 rows per person;
  drop rows whose URL or title appears in any holdout, youtube-*.json or the training pool (print only the count).
- [ ] **Step 4:** Update README; commit `test: blind browsing-session sets for tuning and gating the neighbour step`.

### Task 4: Neighbour step

**Files:**
- Modify: `src/classify/pick.ts`, `src/shared/types.ts`, `src/background/tab-index.ts`, `src/background/groups.ts`,
  every other caller of `autoPick` / `autoGroup` / `pickGroup` (find with grep), `src/io/import-export.ts` and
  `src/background/sync.ts` only if they serialise items (the new field must stay local).
- Create: `tests/quality/neighbours.test.ts`, `tests/quality/sessions-sim.ts`
- Test: `tests/unit/pick.test.ts`, `tests/unit/tab-index.test.ts`, `tests/unit/groups.test.ts`,
  `tests/unit/sync-codec.test.ts` / `import-export.test.ts` (field not exported)

**Interfaces:**
- Consumes: Task 1's `pickGroup` want rule.
- Produces:
  - `export interface Neighbour { vec: ArrayLike<number>; groupId: string; normUrl: string }` (pick.ts)
  - `export type PlacedBy = 'rule' | 'exemplar' | 'head' | 'neighbour' | 'youtube' | 'videos'`
  - `pickGroup(item, vec, groups, head, pool?: Neighbour[]): { groupId: string | null; want: string | null; by: PlacedBy | null }`
  - `Item.placedBy?: PlacedBy` — local only (never synced/exported, no updatedAt bump), written with every auto pick,
    removed when the user places the tab.
  - `export const NEIGHBOUR_SIMILARITY`, `NEIGHBOUR_MIN`, `NEIGHBOUR_K`, `NEIGHBOUR_POOL_MAX` (pick.ts)
  - `export async function neighbourPool(db: Db, items: Item[], groups: Group[]): Promise<Neighbour[]>` (tab-index.ts):
    items in an existing non-suggested group other than `videos` / `other`, `groupSource === 'user'` or `placedBy`
    not in {'neighbour', 'youtube', 'videos'} (missing counts as eligible), most recently active first, capped at
    NEIGHBOUR_POOL_MAX, vectors from `cachedVectors`.
  - `autoPick(item, vec, groups, pool?)` passes the pool through; callers exclude the item itself (by id) from the
    pool they pass.

- [ ] **Step 1: Failing unit tests** in pick.test.ts (unit vectors built so cosines are exact):
  - two pool tabs in `hardware` at cosine ≥ NEIGHBOUR_SIMILARITY, head unsure → `{ groupId: 'hardware', by: 'neighbour', want: null }`
  - one such tab → not placed by neighbour
  - two in `hardware`, two in `programming` (tie) → not placed by neighbour
  - two pool tabs with the same normUrl count as one → not placed
  - pool tab in a group missing from `groups` is ignored
  - pool vector of another length is skipped without throwing
  - head confident (≥ threshold) for `ai` with two `hardware` neighbours → `ai`, `by: 'head'`
  - a rule match wins over neighbours (`by: 'rule'`); exemplar match → `by: 'exemplar'`
  - YouTube video with neighbours agreeing → neighbour group (neighbours come before the low YouTube bar)
  - perf: `pickGroup` with a pool of NEIGHBOUR_POOL_MAX random 384-d vectors, 100 calls, < 500 ms
- [ ] **Step 2:** In tab-index.test.ts: a tab placed by neighbour gets `placedBy: 'neighbour'` and is left out of
  `neighbourPool`; a user-placed tab is in the pool; `placedBy` is not in sync or export payloads (extend the codec /
  export tests). In groups.test.ts: regroup uses the pool and excludes the re-picked item.
- [ ] **Step 3:** Run them → FAIL.
- [ ] **Step 4:** Implement. Order inside `pickGroup`: rule → `classify` (exemplar → `by: 'exemplar'`, head →
  `'head'`) → neighbours (top `NEIGHBOUR_K` pool tabs by cosine with cosine ≥ NEIGHBOUR_SIMILARITY, one vote per
  normUrl; a group with ≥ NEIGHBOUR_MIN votes and strictly more than any other wins) → YouTube bar (`'youtube'`) →
  Videos (`'videos'`) → null. `want` stays null on rule/exemplar/head/neighbour paths. Wire the pool into
  `processBatch` (build it before the transaction from `db.items.all()` and the groups read then; inside the
  transaction drop pool entries whose group no longer exists), into `planRegroup`/`regroupApply`, and into sync and
  import callers. Start constants at SIMILARITY 0.68, MIN 2, K 10, POOL_MAX 2000.
- [ ] **Step 5:** `npm test`, `npm run lint`, `npx tsc --noEmit` → PASS.
- [ ] **Step 6: Tuning harness.** sessions-sim.ts: `simulate(rows, opts)` — per person, in row order, a seeded 30%
  of tabs are user-placed with their true group (if that group exists among installed + needed on-demand groups),
  the rest go through `pickGroup` with the pool so far (product pipeline, real model and head). Returns right,
  wrong, unsorted counts for non-`other` rows and `other` auto-assigned rate. neighbours.test.ts: (a) on
  sessions-tune.json, print (ungated) a sweep over SIMILARITY {0.60…0.80 step 0.02} × MIN {2,3} × K {5,10} plus
  "no neighbours", with right − 2 × wrong; (b) on sessions.json, gate: with the shipped constants, right − 2 × wrong
  is higher than without neighbours, and the wrong-group rate is at most 2 points above it; print aggregates only.
- [ ] **Step 7:** Run the sweep; set the constants to the best right − 2 × wrong on the tune set (ties → higher
  similarity); write the chosen values and the tune numbers in the constants' doc comment. Run the gate once.
- [ ] **Step 8:** `npm run test:quality` → all gates PASS.
- [ ] **Step 9:** Commit `feat: an unsure tab follows its closest grouped tabs` (and a separate
  `test: tune and gate the neighbour step on blind sessions` if cleaner).

### Task 5: Messy YouTube training data (controller task: blind writers)

**Files:**
- Create: `training/train-f.json`
- Modify: `scripts/train-head.mjs` (add to `files` and the header comment), `tests/quality/README.md`

**Interfaces:**
- Produces: `{ title, url, group }` rows: ~1,200 YouTube videos in the messy style (conference talks "Title — Speaker
  (Conf 2025)", interviews, podcasts, explainers, tutorials, notification counters "(3) …", hashtag Shorts,
  clickbait, drama/anime shorts, non-English titles), labelled by subject per training/LABELING.md; ~25% `videos`
  (no clear subject: vlogs, pranks, challenges, reaction compilations, songs without a music context are `music`).
  Spread over every label incl. on-demand ones.

- [ ] **Step 1:** Write the brief (in the dispatch, pointing at LABELING.md) with the style list above.
- [ ] **Step 2:** Dispatch 4 writer agents (model: sonnet), each covering a quarter of the labels plus their share of
  `videos`; they read only LABELING.md.
- [ ] **Step 3:** Merge, validate (labels, YouTube URLs), drop rows overlapping any holdout, youtube-*.json, sessions
  files or the pool (print counts only).
- [ ] **Step 4:** Commit `data: blind messy YouTube titles labelled by subject`.

### Task 6: Retrain the head

**Files:**
- Modify: `src/classify/head.json` (generated), `src/classify/pick.ts` (YOUTUBE_THRESHOLD and its comment),
  `tests/quality/accuracy.test.ts` (floors only upward), `tests/quality/README.md`

- [ ] **Step 1:** `npm run train:head`; record CV/val numbers it prints.
- [ ] **Step 2:** Re-measure YOUTUBE_THRESHOLD on youtube-topics.json the same way as before (highest bar on the
  right − 2 × wrong plateau); update the constant and comment.
- [ ] **Step 3:** `npm run test:quality`; every gate passes. Where a measured rate rose, raise that floor to the new
  measured count (never lower one). Re-run the neighbour sweep; if the best constants moved, update them (Task 4 Step 7).
- [ ] **Step 4:** `npm test` → PASS. Commit `feat: retrained head; videos now means a video with no subject`.

### Task 7: Model comparison

**Files:**
- Create: `docs/superpowers/notes/2026-11-19-model-comparison.md` (numbers table and decision)
- Scratch only: candidate model dirs and heads under the session scratchpad (not committed)

**Interfaces:**
- Consumes: train-head.mjs `MODEL_ID`, `MODEL_PATH`, `POOLING`, `OUT`; accuracy.test.ts `HEAD_PATH`, `MODEL_PATH`.

- [ ] **Step 1:** Download candidates at a pinned revision into the scratchpad, recording SHA-256 of each file:
  `Xenova/bge-base-en-v1.5` (mean? check its config: bge uses CLS, our bge-small uses mean — test both),
  `Xenova/gte-small` (mean), `Xenova/multilingual-e5-small` (mean, needs a `query: ` prefix — add a `PREFIX` env to
  train-head and the test harness only for this experiment), `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (mean).
  Record each q8 ONNX file size.
- [ ] **Step 2:** For each: train a head (`OUT` to scratch), note 5-fold CV top-1; run `npm run test:quality` with
  HEAD_PATH/MODEL_PATH; run the sessions gate with neighbour constants re-swept for that model on the tune set;
  time embedding 200 pool titles in Node (same machine, warm, median of 3) vs bge-small.
- [ ] **Step 3:** Write the note: table (CV, holdout, holdout2, holdout3, youtube-topics, youtube-messy, sessions,
  size MB, ms per 200), and the decision by the spec's rule (≥ 3 points on holdout2, youtube-messy and sessions each;
  ≤ 2× time). Commit `docs: embedding model comparison`.
- [ ] **Step 4:** If no candidate qualifies, Task 8 is skipped (record a ruling in the ledger).

### Task 8: Model swap (only if Task 7 picks a new model)

**Files:**
- Modify: `scripts/model-manifest.mjs`, `src/classify/model.ts`, `src/classify/head.json`, pick.ts constants
  (YOUTUBE_THRESHOLD, neighbour constants re-measured for the new model), `src/offscreen/offscreen.ts` if a prefix is
  needed, `src/shared/url.ts` / `embedText` only if a prefix belongs there, `scripts/third-party-notices.mjs` (model
  licence), `src/background/index.ts` (startup migration)
- Create: `src/background/model-change.ts`
- Test: `tests/unit/model.test.ts`, new `tests/unit/model-change.test.ts`

**Interfaces:**
- Produces: `export async function migrateModel(db: Db, embedFn): Promise<void>` — when chrome.storage.local
  `embedModel` differs from EMBED_MODEL (missing counts as the old bge-small): rebuild each group's `exemplars` by
  embedding its `lessons` texts (keep lessons; exemplars without a lesson are dropped), trained groups' centroids from
  seeds, user groups' centroid from the rebuilt exemplars (else null); then store `embedModel`. Retries on the next
  start if embedding fails (stores nothing).

- [ ] **Step 1:** Failing tests: migration rebuilds exemplars from lessons with the given embedFn; drops vector-only
  exemplars; is a no-op when `embedModel` matches; leaves the flag unset when embedFn throws. model.test.ts already
  checks manifest/model.ts/head agree.
- [ ] **Step 2:** Implement; call `migrateModel` at startup after the embedder is available.
- [ ] **Step 3:** `npm run fetch-model` (or the project's model fetch), `npm test`, `npm run test:quality`,
  `npm run build`, `node scripts/verify-release.mjs` → PASS. Run the @perf e2e locally and record the time.
- [ ] **Step 4:** Commit `feat: switch to <model> for better grouping` (+ migration commit).

### Task 9: Check on the owner's export and finish

- [ ] **Step 1:** Scratch script (scratchpad, not committed): run the product pipeline (rules, head, neighbour pool
  from the export's own placements, as regroup would) over the export with the old and new code; print per-group
  counts before/after and how many of the ~62 tabs found misplaced in the analysis now land where a person would put
  them (the list from the analysis, judged by title — diagnosis only, change nothing in response).
- [ ] **Step 2:** `npm test`, `npm run lint`, `npx tsc --noEmit`, `npm run test:quality`, `npm run test:e2e`,
  `npm run build` → PASS; dist rebuilt.
- [ ] **Step 3:** Report the before/after numbers to the owner; the 1.4.0 release waits for their go-ahead.
