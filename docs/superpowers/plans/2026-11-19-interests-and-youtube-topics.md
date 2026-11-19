# Interests and YouTube Topics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group YouTube videos by topic, add 14 trained on-demand groups that appear when picked or when browsing shows the topic, and ask new users what they browse.

**Architecture:** The classifier head gains 14 labels (synthetic training data, retrained with `npm run train:head`); the model input for YouTube videos drops the "YouTube" source word. A pure `pickGroup()` decides a tab's group *and* the trained label it wanted when that group doesn't exist; a background `growGroups()` pass creates a trained group once 2 auto-placed tabs want it. An interests step (welcome card, Settings, one-time card) creates picked groups through one RPC.

**Tech Stack:** TypeScript, Preact, IndexedDB (idb), Vitest, Playwright, the bundled bge-small model + `scripts/train-head.mjs`.

**Spec:** `docs/superpowers/specs/2026-11-18-interests-and-youtube-topics-design.md`

**Stages (each shippable on its own):** 1 = Tasks 1–3 (YouTube topic first) · 2 = Tasks 4–7 (catalog + on-the-fly groups) · 3 = Tasks 8–9 (interests step) · 4 = Task 10 (sync/import names).

## Global Constraints

- Never read page content; model input stays title + address. No network calls.
- Training and holdout data are synthetic, written by blind agents; real user tabs are never training data. Do not open `tests/quality/holdout.json` / `holdout2.json`.
- Existing gates stay: ≥ 85% top-1 on holdout, ≥ 82% on holdout2, ≤ 35% of `other` auto-assigned — scored with the default (installed) group set.
- New labels, ids and names, exactly: `hardware` "Hardware & making", `science` "Science & engineering", `sports` "Sports", `food` "Food & cooking", `cars` "Cars & vehicles", `home` "Home & garden", `fashion` "Fashion & beauty", `pets` "Pets & animals", `family` "Parenting & family", `jobs` "Jobs & careers", `books` "Books & reading", `photo` "Photography", `anime` "Anime & comics", `realestate` "Real estate".
- On-the-fly threshold: 2 auto-placed tabs wanting the same missing trained group. User-placed tabs never move.
- A trained group the user deleted is never re-created on the fly; picking it in the interests step clears that.
- Labelling borders (from the spec): sports news → sports; recipes/restaurants/cooking videos → food, diet/nutrition → health; science explainers + research news → science; ESP32/Arduino/PCB/CNC/3D-printing docs, forums, repos, videos → hardware; electronics product pages → shopping; maker courses → hardware, general STEM courses → learning; YouTube: `videos` only for no clear subject (vlogs, challenges, reactions, pranks, compilations, channel/home pages).

## Review Focus

- A YouTube video whose topic group doesn't exist and no `videos` group either (user deleted it) → Unsorted, `want` still recorded.
- Two tabs wanting `hardware`, one of them user-placed elsewhere → no group created (only auto-placed tabs count).
- The user deletes a grown group → its tabs go back through the classifier (to Videos/Unsorted), the group is not re-grown by the next pass.
- "Add your own" with a name that matches a trained group or an existing group (any case) → adopts, no duplicate.
- After the update, cached embeddings made with "— YouTube" are not reused (embedding key changes); first pass re-embeds without errors.

---

### Task 1: YouTube model input and the embedding key

**Files:** Modify `src/shared/url.ts` (`embedText`), `src/background/tab-index.ts` (`embeddingKey`). Test: `tests/unit/classify.test.ts`, `tests/unit/background-index.test.ts`.

**Interfaces:** Produces `embedText(item)` unchanged signature; `EMBED_INPUT_VERSION = 2` exported from `tab-index.ts`.

- [ ] **Step 1: Failing tests.** `embedText leaves out the source word for YouTube videos only`: `embedText({ title: 'How To Cut Threads On A Lathe - YouTube', url: 'https://www.youtube.com/watch?v=x' })` does not contain `YouTube` and equals `'How To Cut Threads On A Lathe'`; same for `/shorts/x` and `youtu.be/x`; `https://www.youtube.com/@channel` and a non-YouTube page keep `— <source>`. `embedding key changes with the input version`: `embeddingKey(item)` for the same item differs from `sha1hex(\`${EMBED_MODEL}\n${normUrl}\n${cleanTitle}\`)` (the old key).
- [ ] **Step 2:** `npx vitest run tests/unit/classify.test.ts tests/unit/background-index.test.ts`: FAIL.
- [ ] **Step 3:** `embedText`: when `kindOf(url) === 'watch'` and the host is YouTube (youtube.com, m.youtube.com, youtu.be), return `cleanTitle(...)` only. `embeddingKey`: hash `` `${EMBED_MODEL}\n${EMBED_INPUT_VERSION}\n${normUrl}\n${embedText(i)}` ``.
- [ ] **Step 4:** same command: PASS; then `npx vitest run tests/unit`: PASS.
- [ ] **Step 5:** commit `feat: read YouTube videos by their title only`.

### Task 2: pickGroup with the Videos fallback and the wanted label

**Files:** Create `src/classify/pick.ts`. Modify `src/background/tab-index.ts` (`autoGroup` → uses `pickGroup`; `processBatch` writes `want`), `src/shared/types.ts` (`Item.want?: string`, local only like `embGaveUpAt`). Test: `tests/unit/pick.test.ts`.

**Interfaces:** Produces `pickGroup(item: Pick<Item,'url'|'title'>, vec: ArrayLike<number>, groups: Group[], head: Head): { groupId: string | null; want: string | null }`. `want` = the head's top label when that label ≠ `other`, its score ≥ `head.threshold`, and no group with that id exists; else null. Order: rule (when its group exists) > classify > (YouTube watch page and `videos` exists → `videos`) > null.

- [ ] **Step 1: Failing tests** (fake 2-class head as in classify.test.ts): (a) label `hardware` confident, group missing, YouTube watch URL, `videos` exists → `{ groupId: 'videos', want: 'hardware' }`; (b) same but a normal page → `{ groupId: null, want: 'hardware' }`; (c) `videos` group missing too → `{ groupId: null, want: 'hardware' }`; (d) group present → `{ groupId: 'hardware', want: null }`; (e) label `other` → `want: null`; (f) a rule hit wins.
- [ ] **Step 2:** `npx vitest run tests/unit/pick.test.ts`: FAIL.
- [ ] **Step 3:** implement; `autoGroup` returns `pickGroup(...).groupId`; `processBatch` stores `want` on auto items (cleared when null); `want` never synced, exported or tracked for `updatedAt` (follow `embGaveUpAt`).
- [ ] **Step 4:** `npx vitest run tests/unit`: PASS.
- [ ] **Step 5:** commit `feat: unpicked YouTube topics wait in Videos and remember their topic`.

### Task 3: YouTube re-labelling, YouTube quality check, retrain (Stage 1 ships here)

**Files:** Create `training/LABELING.md` (the borders in Global Constraints + the YouTube rule), `tests/quality/youtube-topics.json` (~150 rows, blind agent, ~60% topic videos across existing labels, ~40% no-topic). Modify `training/train-*.json` and `tests/quality/fixture.json` (re-labels from a blind agent given only LABELING.md and the rows; output reviewed as a diff), `tests/quality/accuracy.test.ts`, `src/classify/head.json` (retrained).

- [ ] **Step 1:** add `youtube topic first` to accuracy.test.ts using the product pipeline (`ruleGroup` > `pickGroup` with the installed group set): prints and asserts topic videos in their topic group ≥ the value measured in Step 4 minus nothing (first run sets it; write it into the test), no-topic videos in `videos` ≥ 70%.
- [ ] **Step 2:** blind agents: one writes youtube-topics.json from LABELING.md; another re-labels pool rows per LABELING.md (YouTube rows only in this stage).
- [ ] **Step 3:** `npm run train:head`, then `npm run test:quality`: the three existing gates PASS.
- [ ] **Step 4:** record the measured topic rate in the test; `npm run test:quality` PASS; `npx vitest run tests/unit` PASS.
- [ ] **Step 5:** commit `feat: YouTube videos are grouped by topic` (data, head, tests).

### Task 4: The 14 on-demand trained groups in seeds

**Files:** Modify `src/classify/seeds.ts` (`StarterGroup.onDemand?: boolean`; 14 entries with ids/names above, distinct colours on the same wheel, an icon each, 6–9 generic seed phrases), `src/classify/assign.ts` (`buildStarterGroups` skips `onDemand`; new `buildTrainedGroup(id: string, embedFn): Promise<Group>`; new `TRAINED_IDS: ReadonlySet<string>`). Test: `tests/unit/classify.test.ts`.

- [ ] **Step 1: Failing tests:** `buildStarterGroups` returns the 17 installed groups (none of the 14 ids); `buildTrainedGroup('hardware', fakeEmbed)` returns `{ id: 'hardware', name: 'Hardware & making', builtIn: true }` with a centroid; unknown id throws; seeds never name brands or sites (extend the existing seeds lint test if present).
- [ ] **Step 2–4:** run `npx vitest run tests/unit/classify.test.ts` FAIL → implement → PASS.
- [ ] **Step 5:** commit `feat: catalog of on-demand trained groups`.

### Task 5: Training data for the 14 labels, new blind holdout, retrain

**Files:** Create `training/train-e.json` (~180 rows per new label, written by several blind agents from LABELING.md, split by label so no agent writes more than ~4 labels), `tests/quality/holdout3.json` (separate blind agent; ≥ 20 rows per new label + ~200 rows across old labels and `other`, new rules). Modify the pool re-labels per the borders (blind agent, whole pool), `scripts/train-head.mjs` (pool includes train-e), `src/classify/head.json`, `tests/quality/accuracy.test.ts`.

- [ ] **Step 1:** add `holdout3 (new labels, all groups present)`: overall non-`other` top-1 ≥ 82%, and per new label ≥ 70%; prints per-label numbers.
- [ ] **Step 2:** blind agents write the data; review for duplicates against the holdouts by URL/title (script, not by reading holdouts).
- [ ] **Step 3:** `npm run train:head`; `npm run test:quality`. Expected: old gates PASS with the default group set; holdout3 gates PASS.
- [ ] **Step 4:** any new label under 70% is removed from seeds, LABELS and data (spec: not shipped half-working); retrain and re-run until PASS. List removed labels in the commit message.
- [ ] **Step 5:** commit `feat: train the on-demand groups`.

### Task 6: Groups appear on the fly

**Files:** Create `src/background/grow.ts`. Modify `src/background/index.ts` (call after `processQueue` in `pipeline`), `src/background/groups.ts` (`deleteGroup` of a trained on-demand group records its id), `src/background/reset.ts` (clears the record), `src/shared/types.ts` (`Group.grownAt?: number`). Test: `tests/unit/grow.test.ts`.

**Interfaces:** Produces `growGroups(db: Db, embedFn, now?: number): Promise<Group[]>` (the groups it created); `REMOVED_TRAINED_KEY = 'removedTrainedGroups'` (chrome.storage.local, string[]); `GROW_MIN = 2`.

- [ ] **Step 1: Failing tests:** two auto items with `want: 'hardware'` (one in `videos`, one Unsorted) → group `hardware` created with `grownAt`, both items moved, `want` cleared; one auto + one user-placed item → nothing; id in REMOVED_TRAINED_KEY → nothing; deleting a grown group records its id and the next `growGroups` creates nothing; a `want` for a non-trained id is ignored.
- [ ] **Step 2–4:** `npx vitest run tests/unit/grow.test.ts` FAIL → implement (one transaction; items re-read inside it; only `groupSource === 'auto'`) → PASS; `npx vitest run tests/unit` PASS.
- [ ] **Step 5:** commit `feat: create a trained group when two tabs need it`.

### Task 7: Notice for a grown group (Stage 2 ships here)

**Files:** Modify `src/ui/dashboard/Dashboard.tsx`, `src/ui/sidepanel/SidePanel.tsx`. Test: `tests/unit/ui-dashboard.test.tsx`, `tests/unit/ui-sidepanel.test.tsx`.

- [ ] **Step 1: Failing tests:** state with a group whose `grownAt` is newer than the page's last seen value → notice `New group: Hardware & making · 2 tabs` with **Undo**; Undo sends `{ t: 'groupDelete', id: 'hardware' }`; the notice shows once per group (seen ids kept in memory per page).
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run tests/unit`).
- [ ] **Step 5:** commit; run `npm run build` and the e2e suite (`npx playwright test`): PASS.

### Task 8: Interests RPC

**Files:** Create `src/background/interests.ts`. Modify `src/shared/rpc.ts` (`{ t: 'interests'; picked: string[]; custom: string[] }`), `src/shared/types.ts` (`Settings.interestsAnswered: boolean`, default false), `src/background/index.ts`. Test: `tests/unit/interests.test.ts`.

**Interfaces:** Produces `applyInterests(db, embedFn, req: { picked: string[]; custom: string[] }, fresh: boolean): Promise<{ created: string[]; removed: string[] }>`; `INTEREST_CHOICES: { id: string; name: string }[]` (17 installed + 14 trained, in seeds order) exported from seeds.ts.

- [ ] **Step 1: Failing tests:** picked trained ids are created and removed from REMOVED_TRAINED_KEY; `fresh` removes unpicked installed groups that have no user-placed tab, are not renamed and are not mirrored, and their auto tabs are re-queued; not `fresh` removes nothing; custom names are parsed like group names, adopt an existing group (case-insensitive) or a trained group of that name, never duplicate; afterwards auto-placed tabs are re-queued (user-placed untouched); `interestsAnswered` becomes true; unknown ids ignored.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** commit `feat: create groups from picked interests`.

### Task 9: Interests step UI (Stage 3 ships here)

**Files:** Create `src/ui/dashboard/Interests.tsx`. Modify `src/ui/dashboard/Onboarding.tsx` (first screen when `!interestsAnswered`), `src/ui/dashboard/Dashboard.tsx` (one-time card "New: choose your interests" on All tabs for onboarded users with `!interestsAnswered`; Skip sets it true), `src/ui/dashboard/Settings.tsx` (General → row "Choose your interests" opening the step in a modal), CSS. Test: `tests/unit/ui-dashboard.test.tsx`, e2e `tests/e2e/ui-onboarding-keyboard.spec.ts`.

- [ ] **Step 1: Failing tests:** chips are toggle buttons (`aria-pressed`), none pressed for a new user, existing groups pressed and disabled in the Settings version; **Continue** sends `{ t: 'interests', picked, custom }`; **Skip** saves `interestsAnswered: true` and sends nothing else; "Add your own" adds a removable chip, rejects empty/too-long names with the group-name rule's message and explains "Learns from tabs you move into it."; keyboard: Tab through chips, Space toggles.
- [ ] **Step 2–4:** FAIL → implement → PASS; build; check in the built-in browser (UI preview) at fresh install and in Settings, light and dark.
- [ ] **Step 5:** commit; e2e onboarding spec updated and passing.

### Task 10: Trained names in sync and import (Stage 4)

**Files:** Modify `src/classify/seeds.ts` (`trainedIdForName(name: string): string | null`, case-insensitive), `src/background/sync.ts` and `src/io/import-export.ts` (a group created from a name that matches a trained group gets that id and `builtIn: true`). Test: `tests/unit/import-export.test.ts`, `tests/unit/sync*.test.ts`.

- [ ] **Step 1: Failing tests:** importing a backup with group "hardware & making" creates group id `hardware` (builtIn) and puts its items there; an existing group with that name is reused; sync pull of a saved tab in "Sports" lands in id `sports`.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run tests/unit`).
- [ ] **Step 5:** commit; full checks (unit, `npm run test:quality`, tsc, eslint, `npx playwright test`).
