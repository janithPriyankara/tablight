# Tab Organizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Manifest V3 extension for Edge and Chrome that indexes every tab in every window and groups them by topic with an on-device embedding model. It also finds duplicates, puts tabs to sleep or stashes them to save memory, snapshots sessions, searches by words and by meaning, and syncs the stash through the browser account. It makes zero network requests.

**Architecture:**
- **Background service worker:** owns the tab index, storage, rules and sync.
- **Offscreen document:** hosts Transformers.js and all-MiniLM-L6-v2. It exists only while embedding and closes after 60 s idle.
- **Popup and dashboard (Preact):** talk to the background through one typed message API.
- **Pure logic modules** (URL handling, classifier, clustering, sync codec, import validation): free of `chrome.*` so they run in Vitest.

**Tech Stack:**
- TypeScript 5, Vite 6 (multi-entry), Preact 10, `idb` 8
- `@huggingface/transformers` 4.3.2 (onnxruntime-web WASM, single-threaded, non-JSEP build)
- Vitest + `fake-indexeddb`, Playwright (Chromium, unpacked extension), ESLint

**Spec:** `docs/superpowers/specs/2026-11-16-tab-organizer-design.md`

## Global Constraints

- **Manifest:** MV3; `minimum_chrome_version: "120"`; `"incognito": "not_allowed"`.
- **Permissions:** exactly `tabs`, `storage`, `unlimitedStorage`, `alarms`, `offscreen`, `favicon`. `optional_permissions: ["tabGroups"]`. **No** `host_permissions`, `content_scripts`, `scripting`, `history`, `webRequest`.
- **CSP (`extension_pages`):** `script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
- **No network:** set `env.allowRemoteModels = false`, `env.allowLocalModels = true`, `env.localModelPath = chrome.runtime.getURL('models/')`, `env.useBrowserCache = false`, `env.useWasmCache = false`.
  - Set `env.backends.onnx.wasm.wasmPaths = { mjs: chrome.runtime.getURL('ort/ort-wasm-simd-threaded.mjs'), wasm: chrome.runtime.getURL('ort/ort-wasm-simd-threaded.wasm') }`, `numThreads = 1`, `proxy = false`.
  - **Do this before the first `pipeline()` call.** Otherwise Transformers.js defaults to the jsdelivr CDN (verified in `transformers.web.js`).
- **Model:**
  - `Xenova/all-MiniLM-L6-v2`, revision `751bff37182d3f1213fa05d7196b954e230abad9`, `dtype: 'q8'`, file `onnx/model_quantized.onnx`.
  - Pinned SHA-256:
    - `onnx/model_quantized.onnx` `afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1`
    - `config.json` `7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7`
    - `tokenizer.json` `da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0`
    - `tokenizer_config.json` `9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3`
    - `special_tokens_map.json` `b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3`
  - Embedding dim 384, mean pooling, normalized.
- **Untrusted text:** titles and URLs are rendered as text only. ESLint bans `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `dangerouslySetInnerHTML`, `eval` and `new Function`.
- **Safe opening:** only `http:`/`https:` URLs are opened or created. Everything else is rejected.
- **Spec numbers:**

  | Area | Values |
  |---|---|
  | Assignment | threshold 0.35; k-NN k=5; exemplars ≤ 50 per group |
  | Clustering | Unsorted cluster trigger ≥ 4 items; cluster min size 3; average-link threshold 0.55 (tune) |
  | Offscreen | idle close 60 s |
  | Auto-sleep | alarm every 5 min; default **off**; onboarding suggests 60 min |
  | Undo / warnings | undo window 10 s; open-all warning > 20 tabs |
  | Snapshots | hourly + on startup + on demand; keep 14 |
  | Last session | shown when < 30% of the last snapshot's URLs are open |
  | Sync | budget 90,000 bytes; chunk ≤ 8,000 bytes (key + JSON); title ≤ 80 chars in sync; tombstones 30 days; keep 3 stash backups |
  | Import | ≤ 20 MB; ≤ 50,000 items |
  | Hotkey | `Alt+Shift+T` opens the dashboard |
  | Quality | ≥ 85% top-1 accuracy on the fixture |
  | Performance | 500 tabs grouped < 15 s; 1,000 items render smoothly (virtualized) |
  | Package | < 45 MB |

- **Source:** the repo is private. `privacy.html` is bundled. The owner will publish the same file via a separate public GitHub Pages repo.
- **Dependencies:** exact versions only, no `^`/`~`, and the lockfile is committed.

## Review Focus

1. **Non-web tabs** (`chrome://`, `edge://`, `file://`, `about:blank`, new-tab page, PDF viewer, `view-source:`): they are listed with state, but never classified, synced or opened from the stash. They never throw. *Test: Task 6.*
2. **Event storms** (closing a 200-tab window, session restore opening 300 tabs): events are debounced. The index ends up exactly matching `chrome.tabs.query({})`, with no duplicate items and no lost user groups. *Test: Task 6.*
3. **Service worker killed mid-classification:** the pending queue is in IndexedDB and resumes on wake. Nothing stays "unclassified" forever. *Test: Task 6.*
4. **Odd titles:** empty, URL-as-title, 2,000-character, emoji/RTL, and notification prefixes like `(3) YouTube`. The cleaned title is used for embedding and display. *Test: Task 2.*
5. **`storage.sync` failures:** quota exceeded, sync disabled, or a write-rate error. Local data stays untouched and the UI shows a sync status. *Test: Task 9.*

---

## File Structure

```
manifest.config.ts            # typed manifest → dist/manifest.json
vite.config.ts                # entries: background, offscreen, popup, dashboard, privacy
scripts/fetch-model.mjs       # download pinned model files, verify SHA-256
scripts/copy-ort.mjs          # copy ort-wasm-simd-threaded.{mjs,wasm} → public/ort/
scripts/package.mjs           # zip dist/, check size < 45 MB, run verify
scripts/verify-release.mjs    # manifest permission/CSP check + model hashes
src/shared/types.ts           # all shared types (Item, Group, Snapshot, Settings, RPC)
src/shared/url.ts             # normalizeUrl, isWebUrl, kindOf, readableSource, cleanTitle
src/shared/vec.ts             # cosine, mean, normalize
src/shared/rpc.ts             # typed message API (send / handle)
src/background/index.ts       # wires listeners, alarms, rpc handlers
src/background/db.ts          # idb wrapper
src/background/tab-index.ts   # reconcile tabs ↔ items, debounced events, queue
src/background/duplicates.ts  # dup groups, badge
src/background/memory.ts      # sleep, autosleep, stash/unstash, closeExtras+undo
src/background/snapshots.ts   # take/list/restore, last-session detection
src/background/sync.ts        # storage.sync adapter (uses sync-codec)
src/background/embedder.ts    # offscreen lifecycle + embed(texts) client
src/offscreen/offscreen.html|ts  # Transformers.js host
src/classify/seeds.ts         # starter groups + seed phrases
src/classify/rules.ts         # domain rules → group / kind
src/classify/assign.ts        # k-NN + centroid assignment, learning
src/classify/cluster.ts       # agglomerative clustering + TF-IDF naming
src/sync/sync-codec.ts        # records, chunking, LWW merge, tombstones, budget
src/io/import-export.ts       # export JSON, validate+merge import
src/search/search.ts          # word + semantic search
src/ui/popup/*, src/ui/dashboard/*, src/ui/common/*  # Preact
src/ui/mock/chrome-mock.ts    # in-page fake chrome.* for UI preview + tests
public/privacy.html, public/icons/*
tests/unit/**, tests/quality/**, tests/e2e/**
```

---

### Task 1: Scaffold, manifest, lint, build

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `manifest.config.ts`, `eslint.config.js`, `vitest.config.ts`, `.gitignore`, `src/shared/types.ts`, `scripts/fetch-model.mjs`, `scripts/copy-ort.mjs`, `scripts/verify-release.mjs`, `public/icons/{16,32,48,128}.png`
- Test: `tests/unit/manifest.test.ts`

**Interfaces — Produces** (`src/shared/types.ts`):
```ts
export type ItemState = 'open' | 'sleeping' | 'stashed';
export type Kind = 'watch' | 'read' | 'other';
export interface Item { id: string; url: string; normUrl: string; title: string; domain: string;
  state: ItemState; tabId?: number; windowId?: number; groupId: string | null;
  groupSource: 'auto' | 'user'; kind: Kind; createdAt: number; lastActiveAt: number;
  stashedAt?: number; updatedAt: number; classifiable: boolean; }
export interface Group { id: string; name: string; color: string; icon: string; builtIn: boolean;
  exemplars: number[][]; centroid: number[] | null; createdAt: number; suggested?: boolean; }
export interface Snapshot { id: string; takenAt: number; windows: { tabs: { url: string; title: string }[] }[]; }
export interface Settings { autoSleepMinutes: number | null; syncEnabled: boolean; mirrorTabGroups: boolean;
  removeOnOpen: boolean; theme: 'system' | 'light' | 'dark'; onboarded: boolean; }
export const DEFAULT_SETTINGS: Settings; // autoSleepMinutes:null, syncEnabled:true, mirrorTabGroups:false, removeOnOpen:true, theme:'system', onboarded:false
```
Item `id` = `crypto.randomUUID()` for open tabs; for stashed items, id = `await sha1hex(normUrl)` (see Task 9).

- [ ] **Step 1:** `git init`; create `package.json` with exact-pinned deps:
  - runtime: `preact`, `idb`, `@huggingface/transformers@4.3.2`
  - dev: `typescript`, `vite`, `@preact/preset-vite`, `vitest`, `fake-indexeddb`, `@playwright/test`, `eslint`, `typescript-eslint`, `eslint-plugin-no-unsanitized`, `archiver`
  - scripts: `prepare:assets` (fetch-model + copy-ort), `build`, `test`, `test:quality`, `test:e2e`, `lint`, `preview:ui`, `package`
- [ ] **Step 2: Write the failing test** `tests/unit/manifest.test.ts`. Import `manifest` from `manifest.config.ts`; assert:
  - `manifest.permissions` sorted equals `['alarms','favicon','offscreen','storage','tabs','unlimitedStorage']`
  - `optional_permissions` equals `['tabGroups']`
  - `host_permissions`, `content_scripts` are undefined; `incognito === 'not_allowed'`
  - `content_security_policy.extension_pages` equals the Global Constraints CSP string exactly
  - `commands['open-dashboard'].suggested_key.default === 'Alt+Shift+T'`
- [ ] **Step 3:** Run `npx vitest run tests/unit/manifest.test.ts` → FAIL (module missing).
- [ ] **Step 4:** Implement `manifest.config.ts`:
  - `background.service_worker: 'background.js'`, `type: 'module'`
  - `action.default_popup: 'popup.html'`
  - `web_accessible_resources: []`
  - `vite.config.ts` writes it to `dist/manifest.json`; Rollup inputs are background, offscreen.html, popup.html, dashboard.html and privacy.html
- [ ] **Step 5:** Implement `scripts/fetch-model.mjs`:
  - download the 5 pinned files from `https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/<rev>/<file>` into `public/models/Xenova/all-MiniLM-L6-v2/`
  - verify SHA-256 against the constants and exit 1 on mismatch; skip the download if the file exists with the right hash
- [ ] **Step 6:** Implement `scripts/copy-ort.mjs`: copy `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.{mjs,wasm}` → `public/ort/`. Add `public/models` and `public/ort` to `.gitignore`.
- [ ] **Step 7:** Configure `eslint.config.js`:
  - `no-unsanitized/property` and `no-unsanitized/method`
  - `no-restricted-syntax` for JSX attribute `dangerouslySetInnerHTML`
  - `no-restricted-properties` for `document.write`
  - `no-eval`, `no-new-func`
- [ ] **Step 8:** Run `npm run prepare:assets && npm run build && npx vitest run tests/unit/manifest.test.ts && npm run lint` → PASS. `dist/manifest.json` exists, and `dist/models/.../model_quantized.onnx` is 22,972,370 bytes.
- [ ] **Step 9:** Commit `chore: scaffold MV3 extension with pinned model assets`.

### Task 2: URL & title utilities

**Files:**
- Create: `src/shared/url.ts`, `src/shared/vec.ts`
- Test: `tests/unit/url.test.ts`, `tests/unit/vec.test.ts`

**Interfaces — Produces:**
```ts
normalizeUrl(url: string): string            // dedupe key
isWebUrl(url: string): boolean               // http/https only
isSafeToOpen(url: string): boolean           // = isWebUrl, rejects credentials in URL (user:pass@)
kindOf(url: string): Kind                    // watch for video hosts
readableSource(url: string): string          // "YouTube video", "GitHub repository org repo"
cleanTitle(title: string, url: string): string
embedText(item: Pick<Item,'title'|'url'>): string   // `${cleanTitle} — ${readableSource}`
cosine(a: ArrayLike<number>, b: ArrayLike<number>): number; mean(vs: number[][]): number[]; normalize(v: number[]): number[]
```

- [ ] **Step 1: Write failing tests** (`url.test.ts`):

  **`normalizeUrl`**

  | Input | Expected |
  |---|---|
  | `https://WWW.Example.com/a/?utm_source=x&b=1#top` | `https://example.com/a?b=1` |
  | `https://www.youtube.com/watch?v=abc&t=42s&si=zz&list=L1` | `https://youtube.com/watch?v=abc&list=L1` |
  | `https://youtu.be/abc?t=3` | `https://youtube.com/watch?v=abc` |
  | `https://app.com/#/inbox/3` | keeps `#/inbox/3` |
  | `https://x.com/?fbclid=1&gclid=2&mc_eid=3&ref=hn` | `https://x.com/` |
  | `https://a.com/path/` | `https://a.com/path` |

  Query params are sorted. Invalid input is returned unchanged.

  **`isWebUrl` / `isSafeToOpen`**
  - true for `http://` and `https://`
  - false for `javascript:alert(1)`, `data:text/html,x`, `file:///etc/passwd`, `chrome://settings`, `edge://flags`, `about:blank`, `view-source:https://a.com`, `blob:`
  - `isSafeToOpen('https://u:p@a.com')` is false

  **`kindOf`**
  - `'watch'` for youtube.com/watch, youtu.be, netflix.com, primevideo.com, disneyplus.com, twitch.tv, vimeo.com, hulu.com, max.com, and imdb.com/title/*
  - `'read'` for other web pages; `'other'` for non-web

  **`cleanTitle`** (Review Focus 4)
  - `'(3) Agents tutorial - YouTube'` → `'Agents tutorial'`
  - `''` with url `https://a.com/x-y-z` → `'a.com x y z'`
  - a title equal to its URL → `'<host> <path words>'`
  - a 2,000-character title → length ≤ 300
  - emoji/RTL text is preserved
  - site suffixes ` - YouTube`, ` | Netflix`, ` - GitHub` are stripped

  **`vec.test.ts`**
  - `cosine([1,0],[1,0])` = 1; `cosine([1,0],[0,1])` = 0
  - `normalize` gives unit length; `mean` of 2 vectors is correct

- [ ] **Step 2:** Run `npx vitest run tests/unit/url.test.ts tests/unit/vec.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Tracking-param list: `utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`, `mc_eid`, `mc_cid`, `si`, `ref`, `ref_src`, `igshid`, `spm`, `_hsenc`, `_hsmi`. Use `URL`; never regex-parse whole URLs.
- [ ] **Step 4:** Run → PASS. Commit `feat: url normalization, safe-url, title cleaning`.

### Task 3: IndexedDB layer

**Files:**
- Create: `src/background/db.ts`
- Test: `tests/unit/db.test.ts` (uses `fake-indexeddb/auto`)

**Interfaces — Produces:**
```ts
openDb(name?: string): Promise<Db>
interface Db {
  items: { get(id): Promise<Item|undefined>; put(i: Item): Promise<void>; delete(id): Promise<void>;
           all(): Promise<Item[]>; byTabId(tabId: number): Promise<Item|undefined>; byNormUrl(u: string): Promise<Item[]>; byState(s: ItemState): Promise<Item[]> };
  groups: { get; put; delete; all(): Promise<Group[]> };
  embeddings: { get(key: string): Promise<Float32Array|undefined>; put(key: string, v: Float32Array): Promise<void> }; // key = sha1(normUrl + '\n' + cleanTitle)
  queue: { add(itemId: string): Promise<void>; take(n: number): Promise<string[]>; remove(ids: string[]): Promise<void>; size(): Promise<number> };
  snapshots: { put; all(): Promise<Snapshot[]>; delete };
  tombstones: { put(t: {id: string; deletedAt: number}): Promise<void>; all(); prune(olderThan: number): Promise<void> };
  stashBackups: { push(items: Item[]): Promise<void>; all(): Promise<{takenAt:number; items: Item[]}[]> }; // keeps last 3
  settings: { get(): Promise<Settings>; set(p: Partial<Settings>): Promise<Settings> };
  tx<T>(stores: string[], fn: (t) => Promise<T>): Promise<T>;
}
```

- [ ] **Step 1: Write failing tests**
  - put/get round trip for each store; `byTabId`, `byNormUrl` and `byState` indexes work
  - `queue.take(2)` returns the oldest 2 without removing them; `remove` deletes them
  - `queue.add` of an existing id doesn't duplicate it
  - `stashBackups.push` ×4 keeps 3, newest first
  - `settings.get()` on an empty DB equals `DEFAULT_SETTINGS`
  - `tombstones.prune(now - 30d)` removes only older entries
  - an Item with a `Float32Array` embedding in the embeddings store survives a round trip
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with `idb` `openDB('tab-organizer', 1, upgrade)`, with indexes `tabId`, `normUrl`, `state`. The queue store is keyed by itemId with an `addedAt` index.
- [ ] **Step 4:** Run → PASS. Commit `feat: indexeddb storage layer`.

### Task 4: Embedding engine (offscreen)

**Files:**
- Create: `src/offscreen/offscreen.html`, `src/offscreen/offscreen.ts`, `src/background/embedder.ts`, `src/shared/rpc.ts`
- Test: `tests/unit/embedder.test.ts`, `tests/quality/embed-node.test.ts`

**Interfaces — Produces:**
```ts
// rpc.ts — one discriminated union for every UI↔background and background↔offscreen message
export type Req =
  | { t: 'embed'; texts: string[] }                       // background → offscreen
  | { t: 'state' }                                         // ui → bg: returns DashboardState
  | { t: 'search'; q: string; semantic: boolean }
  | { t: 'moveItems'; ids: string[]; groupId: string }
  | { t: 'sleep'; ids: string[] } | { t: 'stash'; ids: string[] } | { t: 'open'; id: string }
  | { t: 'close'; ids: string[] } | { t: 'closeExtras' } | { t: 'undo'; token: string }
  | { t: 'groupCreate'; name: string; ids: string[] } | { t: 'groupRename'; id: string; name: string }
  | { t: 'groupMerge'; from: string; into: string } | { t: 'groupDelete'; id: string }
  | { t: 'acceptSuggestion'; id: string } | { t: 'regroupPreview' } | { t: 'regroupApply' }
  | { t: 'snapshotNow' } | { t: 'sessionAction'; id: string; action: 'openAll'|'stashAll'|'delete' }
  | { t: 'settings'; patch: Partial<Settings> } | { t: 'export' } | { t: 'import'; json: string };
export function send<R>(req: Req): Promise<R>;
export function handle(h: (req: Req, sender: chrome.runtime.MessageSender) => Promise<unknown>): void;
// embedder.ts (background)
export function embed(texts: string[]): Promise<Float32Array[]>;   // batches of 32, creates offscreen on demand, idle-close 60 s
```
- `handle` rejects messages whose `sender.id !== chrome.runtime.id`, or that have `sender.tab` set from a web origin.
- `handle` validates `req.t` against an allowlist and ignores unknown types.

- [ ] **Step 1: Write failing tests** (`embedder.test.ts`, with a mocked `chrome.offscreen`/`runtime.sendMessage`):
  - `embed(['a'])` calls `chrome.offscreen.createDocument` once with `reasons:['WORKERS']`, `url:'offscreen.html'`
  - two concurrent `embed` calls create only one document
  - after 60 s with no calls (fake timers), `closeDocument` is called
  - 70 texts → 3 offscreen messages (32/32/6), and the results are in input order
  - `handle` ignores a message with `sender.id = 'evil'` and a message with `t:'nope'`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. `offscreen.ts` sets the `env` exactly as in Global Constraints, then `pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2',{dtype:'q8',device:'wasm'})`. It calls `extractor(texts,{pooling:'mean',normalize:true})` and returns `Array<number[]>` (structured-clone safe).
- [ ] **Step 4: Write** `tests/quality/embed-node.test.ts` (vitest project `quality`, Node, `@huggingface/transformers` with `env.localModelPath='public/models/'`, `allowRemoteModels=false`):
  - the vectors have length 384 and norm ≈ 1 ± 1e-3
  - `cosine(e('LangGraph agents tutorial — YouTube video'), e('Claude Agent SDK docs — docs.anthropic.com'))` > `cosine(e('LangGraph agents tutorial — YouTube video'), e('Best pasta recipe — food blog'))`
- [ ] **Step 5:** Run `npm test && npm run test:quality` → PASS. Commit `feat: offscreen embedding engine, bundled model, no remote loading`.

### Task 5: Classifier — rules, seeds, assignment, clustering, learning

**Files:**
- Create: `src/classify/seeds.ts`, `src/classify/rules.ts`, `src/classify/assign.ts`, `src/classify/cluster.ts`
- Test: `tests/unit/classify.test.ts`, `tests/quality/fixture.json` (≈300 labelled `{title,url,group}`), `tests/quality/accuracy.test.ts`

**Interfaces — Produces:**
```ts
// seeds.ts
export const STARTER_GROUPS: { id: string; name: string; color: string; icon: string; seeds: string[] }[];
// ids: movies, tv, videos, ai, programming, design, shopping, news, social, music, learning, docs, work, travel, finance, health, games, other
// rules.ts
export function ruleGroup(url: string, title: string): string | null;   // e.g. imdb.com/title + "TV Series" → 'tv'; netflix.com/title → 'movies'|'tv' by title hint
// assign.ts
export interface Assignment { groupId: string | null; score: number }
export function assign(vec: ArrayLike<number>, groups: Group[], opts?: { threshold?: number; k?: number }): Assignment; // threshold 0.35, k 5
export function learn(group: Group, vec: number[]): Group;  // push exemplar (cap 50, drop oldest), recompute centroid
export function buildStarterGroups(embedFn: (t: string[]) => Promise<Float32Array[]>): Promise<Group[]>;
// cluster.ts
export interface Suggestion { itemIds: string[]; name: string }
export function suggestGroups(items: { id: string; title: string; domain: string; vec: number[] }[], opts?: { threshold?: number; minSize?: number }): Suggestion[]; // 0.55, 3
export function nameCluster(titles: string[], domains: string[]): string;  // TF-IDF top 2 terms + top domain if shared by ≥ 60%, e.g. "Rust · async"
```
**Scoring algorithm** (decided here):
- `score(g) = 0.5 * cosine(vec, g.centroid) + 0.5 * mean(top-k cosine(vec, exemplar))`
- Pick the best g. If `score < threshold`, return `groupId:null`.
- Group `other` is never assigned automatically.

**Pipeline order in callers:** user group > `ruleGroup` > `assign` > Unsorted (`null`).

- [ ] **Step 1: Write failing unit tests** (synthetic vectors, no model):
  - `assign` picks the group whose exemplars are nearest and returns null below the threshold
  - `learn` caps exemplars at 50 and keeps the newest 50
  - `suggestGroups` on 3 tight clusters of 4 plus 2 outliers returns 3 suggestions with the outliers left out
  - minSize 3 is respected
  - `nameCluster(['Rust async book','Async Rust tokio guide','Rust async traits'], ['doc.rust-lang.org','tokio.rs','blog.x'])` contains `'Rust'` and `'async'` (case-insensitive) and no stop-words
  - `ruleGroup('https://www.netflix.com/title/123','Stranger Things | Netflix')` → `'tv'` or `'movies'`, not null
  - `ruleGroup('https://example.com','x')` → null
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. Clustering is O(n²) average-link on cosine distance, capped at 2,000 items: above that, cluster only the most recent 2,000.
- [ ] **Step 4: Write** `tests/quality/accuracy.test.ts`:
  - embed the fixture with the real model (Node)
  - build starter groups, run the pipeline
  - assert top-1 accuracy ≥ 0.85 over items whose label ≠ `other`
  - print a confusion summary
  - Tune seeds and threshold until it passes; record the final threshold in `assign.ts` as `DEFAULT_THRESHOLD`.
- [ ] **Step 5:** Run `npm test && npm run test:quality` → PASS. Commit `feat: on-device classifier with rules, kNN, clustering, learning`.

### Task 6: Background tab index, classification queue, duplicates

**Files:**
- Create: `src/background/tab-index.ts`, `src/background/duplicates.ts`, `src/background/index.ts`, `src/ui/mock/chrome-mock.ts`
- Test: `tests/unit/tab-index.test.ts`, `tests/unit/duplicates.test.ts`

**Interfaces — Consumes:** `Db` (T3), `embed` (T4), `assign`/`ruleGroup`/`suggestGroups` (T5), url utils (T2).

**Interfaces — Produces:**
```ts
// tab-index.ts
export function reconcile(db: Db, tabs: chrome.tabs.Tab[]): Promise<void>;  // makes open/sleeping items match tabs exactly
export function onTabEvent(): void;               // debounced 500 ms → chrome.tabs.query({}) → reconcile → enqueue new classifiable items
export function processQueue(db: Db): Promise<number>; // take 32 → embed (cached) → rule/assign → put; loops until empty; returns processed
export function maybeSuggest(db: Db): Promise<void>;   // when Unsorted ≥ 4 → suggestGroups → store as Group{suggested:true}
// duplicates.ts
export function findDuplicates(items: Item[]): Map<string, Item[]>;  // normUrl → ≥ 2 open/sleeping items
export function updateBadge(db: Db, activeTabId?: number): Promise<void>; // badge text "2×" on a tab with a duplicate, else ''
// chrome-mock.ts
export function installChromeMock(seed?: { windows: { tabs: Partial<chrome.tabs.Tab>[] }[] }): ChromeMockControl;
```
**Rules:**
- `reconcile` matches existing items by `tabId`, then by `normUrl+windowId` for restored sessions whose tab ids changed.
- It sets `state` to `sleeping` when `tab.discarded`, and `classifiable = isWebUrl(url)`.
- Items whose tab is gone and that are not stashed are deleted.
- An item whose `normUrl` changed (navigation) gets a new embedding: it is re-enqueued, but `groupSource:'user'` is kept.

- [ ] **Step 1: Write failing tests** (with `installChromeMock` and fake-indexeddb):
  - reconcile of 3 windows × 5 tabs → 15 items with the correct windowIds
  - **Review Focus 1:** tabs with `chrome://settings`, `edge://newtab`, `file:///x.pdf`, `about:blank` and `view-source:https://a.com` produce items with `classifiable:false`. They are never enqueued and never throw.
  - **Review Focus 2:** fire 300 `onCreated` events then 200 `onRemoved` within 100 ms. After the debounce, the item count equals `tabs.query({})` length and has no duplicate `tabId`. A user-grouped item whose tab survived keeps its `groupId`.
  - **Review Focus 3:** enqueue 70 items, run `processQueue` with an embed mock that throws after the first batch (simulating SW death), then re-run `processQueue`. All 70 end up classified and the queue is empty.
  - the embedding cache: a second item with the same normUrl+title doesn't call `embed` again
  - `findDuplicates`: two tabs `https://a.com/x?utm_source=1` and `https://www.a.com/x/` form one dup group
  - the badge shows `'2×'` for the active dup tab and `''` otherwise
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. `index.ts`:
  - registers tabs/windows listeners at the top level (MV3 requirement)
  - on startup: `reconcile` + `processQueue`
  - alarm `classify-kick` every 1 min while the queue is non-empty
  - on install: `buildStarterGroups`
- [ ] **Step 4:** Run → PASS. Commit `feat: background tab index, resumable classification queue, duplicates`.

### Task 6b: Group management & native tab-group mirroring

**Files:**
- Create: `src/background/groups.ts`
- Test: `tests/unit/groups.test.ts`

**Interfaces — Produces:**
```ts
moveItems(db: Db, ids: string[], groupId: string): Promise<void>;     // groupSource='user' + learn() with each item's cached vec
createGroup(db: Db, name: string, ids: string[]): Promise<Group>;      // exemplars = vecs of ids
renameGroup(db: Db, id: string, name: string): Promise<void>;
mergeGroups(db: Db, from: string, into: string): Promise<void>;        // items + exemplars move; from deleted
deleteGroup(db: Db, id: string): Promise<void>;                        // items → Unsorted (groupId null, groupSource auto); built-in 'other' can't be deleted
acceptSuggestion(db: Db, id: string): Promise<void>;                   // suggested=false
regroupPreview(db: Db): Promise<{ groupId: string | null; before: number; after: number }[]>;  // only groupSource='auto'
regroupApply(db: Db): Promise<number>;
mirrorTabGroups(db: Db, windowId: number): Promise<void>;              // only if settings.mirrorTabGroups && permission granted; chrome.tabs.group + tabGroups.update({title,color})
```
- [ ] **Step 1: Write failing tests**
  - `moveItems` sets `groupSource:'user'` and the group gains exemplars
  - `regroupApply` never changes `user` items (spec 7.3 stability)
  - `regroupPreview` doesn't write anything
  - `deleteGroup('other')` rejects
  - merge moves every item
  - `mirrorTabGroups` with permission denied doesn't call `chrome.tabs.group`
- [ ] **Step 2–4:** FAIL → implement, wiring the rpc handlers in `index.ts` → PASS. Commit `feat: group management and optional tab-group mirroring`.

### Task 7: Memory — sleep, auto-sleep, stash, close extras, undo

**Files:**
- Create: `src/background/memory.ts`
- Test: `tests/unit/memory.test.ts`

**Interfaces — Produces:**
```ts
sleepTabs(db: Db, ids: string[]): Promise<{ slept: number; skipped: number }>; // skip active, pinned, audible
autoSleep(db: Db, now: number): Promise<number>;                  // uses settings.autoSleepMinutes; null → 0
stash(db: Db, ids: string[]): Promise<{ token: string }>;        // persist stashed item, then tabs.remove
openItem(db: Db, id: string): Promise<void>;                     // open tab → tabs.update+windows.update focus; stashed → isSafeToOpen → tabs.create; removeOnOpen → delete + tombstone
closeExtras(db: Db): Promise<{ closed: number; token: string }>; // keep most recent lastActiveAt per dup group
closeTabs(db: Db, ids: string[]): Promise<{ token: string }>;
undo(db: Db, token: string): Promise<boolean>;                    // within 10 s: recreate closed tabs (http/https only) / restore stash
```
- [ ] **Step 1: Write failing tests**
  - `sleepTabs` skips active, pinned and audible tabs and calls `tabs.discard` for the rest
  - `autoSleep` with `autoSleepMinutes:null` does nothing; with 60 it discards only tabs inactive > 60 min
  - `stash` writes the item with `state:'stashed'` **before** `tabs.remove`: if `tabs.remove` rejects, the item still exists (anti-goal: never lose tabs)
  - `openItem` on a stashed `javascript:alert(1)` item (injected directly into the DB) does **not** call `tabs.create` and returns an error
  - `closeExtras` keeps the most recently active copy
  - `undo` within 10 s recreates the tabs; after 10 s (fake timers) it returns false
- [ ] **Step 2:** FAIL → **Step 3:** implement. Register alarm `auto-sleep` with period 5. → **Step 4:** PASS. Commit `feat: sleep, auto-sleep, stash, close extras with undo`.

### Task 8: Snapshots & last session

**Files:**
- Create: `src/background/snapshots.ts`
- Test: `tests/unit/snapshots.test.ts`

**Interfaces — Produces:**
```ts
takeSnapshot(db: Db, now: number): Promise<Snapshot>;       // web URLs only; keep 14
lastSessionMissing(db: Db, openNormUrls: Set<string>): Promise<Snapshot | null>; // < 30% present → snapshot
sessionAction(db: Db, id: string, action: 'openAll'|'stashAll'|'delete'): Promise<{ needsConfirm?: number }>;
```
- `openAll` with > 20 tabs returns `{needsConfirm:n}` unless called with a confirm flag; it opens one new window.
- `stashAll` copies into the stash, de-duplicated by normUrl.

- [ ] **Step 1: Write failing tests**
  - 16 snapshots → 14 kept
  - non-web tabs are excluded
  - `lastSessionMissing`: 10 urls with 2 present → returns the snapshot; with 5 present → null
  - `stashAll` twice doesn't duplicate items
  - `openAll` with 25 tabs → `needsConfirm: 25`
- [ ] **Step 2–4:** FAIL → implement (alarm `snapshot` period 60; on `runtime.onStartup` compute `lastSessionMissing` *before* taking a new snapshot) → PASS. Commit `feat: session snapshots and last-session restore`.

### Task 9: Sync

**Files:**
- Create: `src/sync/sync-codec.ts`, `src/background/sync.ts`
- Test: `tests/unit/sync-codec.test.ts`, `tests/unit/sync.test.ts`

**Interfaces — Produces:**
```ts
// sync-codec.ts (pure)
export type SyncRecord = [id: string, normUrl: string, title: string, group: string, stashedAt: number, updatedAt: number];
export type Tomb = [id: string, deletedAt: number];
export function toRecord(i: Item, groupName: string): SyncRecord;          // title truncated to 80
export function encodeChunks(recs: SyncRecord[], tombs: Tomb[], budget = 90_000, chunkMax = 8_000):
  { chunks: Record<string, string>; included: string[]; localOnly: string[] };  // keys "v1:0".."v1:n", newest stashedAt first
export function decodeChunks(store: Record<string, unknown>): { recs: SyncRecord[]; tombs: Tomb[] }; // ignores malformed
export function merge(local: SyncRecord[], localTombs: Tomb[], remote: SyncRecord[], remoteTombs: Tomb[]):
  { upserts: SyncRecord[]; deletes: string[]; tombs: Tomb[] };             // LWW by updatedAt; tomb wins if deletedAt ≥ updatedAt
export function sha1hex(s: string): Promise<string>;
// sync.ts
export function pushSync(db: Db): Promise<SyncStatus>;  // debounced 5 s; writes chunks; removes stale keys
export function pullSync(db: Db): Promise<SyncStatus>;  // storage.onChanged('sync') + startup
export type SyncStatus = { ok: true; synced: number; localOnly: number } | { ok: false; reason: 'quota'|'disabled'|'rate'|'error'; message: string };
```
- `pullSync` takes `db.stashBackups.push(stash)` before applying deletes.
- Unknown group names create a Group with an embedded centroid of the name.
- Records whose `normUrl` fails `isWebUrl` are dropped.

- [ ] **Step 1: Write failing tests**
  - every encoded chunk satisfies `key.length + JSON.stringify(value).length ≤ 8000`, and the total is ≤ 90,000
  - 3,000 records → `localOnly` non-empty, and `included` holds the newest
  - after removing 500 records and re-encoding, previously local-only items are promoted (newest first)
  - `decodeChunks` with garbage keys/values, a `__proto__` key or a non-array → ignored, no throw
  - merge:
    - remote newer `updatedAt` wins
    - a tomb newer than the record deletes it
    - a record newer than the tomb survives
    - a local item absent remotely without a tomb is **kept**
  - tombs older than 30 days are pruned on encode
  - **Review Focus 5:** with a `chrome.storage.sync.set` mock rejecting `QUOTA_BYTES quota exceeded`, `pushSync` returns `{ok:false, reason:'quota'}`, local items are unchanged, and the status is stored for the UI. With `syncEnabled:false` there are no calls to `storage.sync`.
  - `pullSync` applying a delete pushes a stash backup first
  - a remote record with a `javascript:` normUrl is dropped
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat: chunked stash sync with tombstones and LWW`.

### Task 10: Import / export

**Files:**
- Create: `src/io/import-export.ts`
- Test: `tests/unit/import-export.test.ts`

**Interfaces — Produces:**
```ts
exportJson(db: Db): Promise<string>;  // { format:'tab-organizer', version:1, exportedAt, groups:[{id,name,color,icon}], items:[{url,title,groupName,state:'stashed',stashedAt}], snapshots }
parseImport(json: string): { ok: true; data: ImportData } | { ok: false; error: string };  // pure validation
applyImport(db: Db, data: ImportData): Promise<{ added: number; skipped: number }>;      // merge by normUrl, never deletes
```
- [ ] **Step 1: Write failing tests** for `parseImport`. Each must be rejected or skipped, never throw:
  - input > 20 MB → `ok:false`
  - > 50,000 items → `ok:false`
  - wrong `format` → `ok:false`
  - an item with url `javascript:alert(1)` / `data:` / `file:` → skipped
  - a top-level `"__proto__":{"polluted":1}` → `({}).polluted === undefined` afterwards
  - title > 1,000 chars → truncated
  - non-string fields → item skipped
  - deeply nested JSON (10,000 levels) → `ok:false` without stack overflow (pre-check depth by scanning brackets)
  - **round trip:** `parseImport(await exportJson(db))` is ok and `applyImport` on a fresh DB recreates the same stashed normUrls
  - importing the same file twice adds 0 the second time
- [ ] **Step 2–4:** FAIL → implement (copy validated fields into fresh objects; never `Object.assign` from parsed input) → PASS. Commit `feat: validated import/export`.

### Task 11: Search

**Files:**
- Create: `src/search/search.ts`
- Test: `tests/unit/search.test.ts`

**Interfaces — Produces:**
```ts
wordSearch(items: Item[], groups: Group[], q: string, limit = 50): Item[];   // tokens AND-matched over title/domain/group name, case/diacritic-insensitive, prefix + 1-typo tolerance for tokens ≥ 5 chars
semanticSearch(qVec: ArrayLike<number>, items: { item: Item; vec: ArrayLike<number> }[], limit = 20, min = 0.3): Item[];
```
- [ ] **Step 1: Write failing tests**
  - `wordSearch` "agnet sdk" finds "Claude Agent SDK docs" (1 typo)
  - "youtube" matches by domain
  - an empty query → []
  - results are ranked by matches then `lastActiveAt`
  - `semanticSearch` orders by cosine and drops results below `min`
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat: word and semantic search`.

### Task 12: Popup UI

**Files:**
- Create: `src/ui/popup/popup.html`, `src/ui/popup/Popup.tsx`, `src/ui/common/{ItemRow.tsx,Favicon.tsx,useDashboardState.ts,theme.css}`
- Test: `tests/unit/ui-popup.test.tsx` (Preact testing via `@testing-library/preact` + jsdom)

**Interfaces — Consumes:** `send` (T4).
- Background `state` returns `DashboardState = { items: Item[]; groups: (Group & { count: number; watchCount: number })[]; dupCount: number; windows: number; sleeping: number; activeDup?: { item: Item; others: Item[] }; syncStatus: SyncStatus; lastSession?: Snapshot; modelReady: boolean }`.
- **Add this handler to `background/index.ts`.**

**`Favicon`:**
- `src = chrome.runtime.getURL('/_favicon/?pageUrl=' + encodeURIComponent(url) + '&size=32')`
- non-web URLs get a local placeholder icon

**Popup layout (≈380×560):**
- totals line
- duplicate alert (Switch / Close this one)
- search box
- top 6 groups with count and "▶ n to watch"
- buttons: Open dashboard / Stash this window / Sleep inactive

- [ ] **Step 1: Write failing tests**
  - the popup renders totals from a mocked `state`
  - a title `<img src=x onerror=alert(1)>` renders as literal text (`container.querySelector('img[src=x]')` is null)
  - the dup alert shows only when `activeDup` is set
  - typing in search calls `send({t:'search',…})` debounced 150 ms
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat: popup`.

### Task 13: Dashboard UI

**Files:**
- Create: `src/ui/dashboard/{dashboard.html,Dashboard.tsx,GroupList.tsx,ItemGrid.tsx,Suggestions.tsx,Sessions.tsx,Settings.tsx,Onboarding.tsx,UndoToast.tsx}`, `public/privacy.html`
- Test: `tests/unit/ui-dashboard.test.tsx`

**Behaviour:**
- **Left column:**
  - groups with counts and watch badges
  - special views: All, Unsorted, Duplicates, Stashed, Sessions, Settings
  - suggested groups with Accept / Dismiss
- **Main area:**
  - a virtualized grid (window by scroll position; render only visible rows + 10 overscan) of ItemRow, showing favicon, title, domain, "Window n", state chip and actions (open/switch, sleep, stash, close, move-to)
  - multi-select with shift/cmd
  - drag-and-drop onto a group calls `moveItems`, which triggers `learn`
- **Toolbar:** search, "Stash group", "Sleep group", "Close duplicates", "Re-group everything" (a preview modal with per-group counts → Apply).
- **Undo:** a toast for 10 s after close/stash.
- **Onboarding:** shown when `!settings.onboarded`. It explains privacy in 3 lines and offers "Turn on auto-sleep after 60 min".
- **Settings:**
  - auto-sleep minutes / off
  - sync toggle + status line ("Synced 412 · 37 only on this device", or the error reason)
  - remove-on-open
  - mirror to browser tab groups (calls `chrome.permissions.request({permissions:['tabGroups']})`)
  - theme
  - export (download via `Blob` + `a[download]`, no `downloads` permission) / import (file input → `send({t:'import'})`)
  - link to privacy.html
- **Model not ready** (`modelReady:false`): show a "Grouping your tabs…" progress state. Items stay visible in Unsorted.

- [ ] **Step 1: Write failing tests**
  - 1,000 items → fewer than 80 ItemRow DOM nodes rendered
  - selecting 3 items and dropping on a group sends `{t:'moveItems', ids:[3 ids], groupId}`
  - "Open all" on a 25-tab session shows the confirm dialog
  - a malicious title renders as text
  - the Re-group preview shows counts and sends nothing until Apply
- [ ] **Step 2–4:** FAIL → implement → PASS. Commit `feat: dashboard`.

### Task 14: UI preview in the built-in browser

**Files:**
- Create: `vite.preview.config.ts`, `src/ui/mock/preview-entry.ts`, `src/ui/mock/fixtures.ts` (~250 realistic tabs across 6 windows, built from `tests/quality/fixture.json`, including dups and sleeping tabs)

**Behaviour:**
- `npm run preview:ui` serves the popup and dashboard on `http://localhost:5174`.
- `installChromeMock` and an in-page fake background are wired in before mounting, so all RPCs work against the fixture with a fake `embed` (pre-computed vectors from the fixture are written to `fixtures.vectors.json` by a one-off script under `scripts/`).

- [ ] **Step 1:** Add `.claude/launch.json` entry `ui-preview` (`npm run preview:ui`, port 5174).
- [ ] **Step 2:** Open it with the built-in browser (`preview_start` name `ui-preview`), then:
  - check the dashboard at desktop and the popup at 380×560
  - check light and dark themes
  - drag a tab to another group, search "agent", close duplicates + undo, run onboarding
  - check that the console has no errors
- [ ] **Step 3:** Fix what's found. Commit `chore: mocked UI preview for visual testing`.

### Task 15: End-to-end in real Chromium

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/extension.spec.ts`, `tests/e2e/fixtures/server.ts` (local http server on 127.0.0.1 serving ~50 pages with realistic `<title>`s)

- [ ] **Step 1: Write the spec.** Launch `chromium.launchPersistentContext` with `--disable-extensions-except=dist --load-extension=dist` (headless `new`), and get the extension id from the SW url.
  - Open 50 local pages across 3 windows, including 3 dups.
  - Open the dashboard and wait for `modelReady`.
  - Assert ≥ 5 non-empty groups, a Duplicates count of 3, and that "Close duplicates" leaves 47 tabs.
  - Stash a group: the tabs close and the items appear in Stashed. Open one: a tab appears and the item leaves the stash.
  - Sleep a tab: `tab.discarded === true`.
  - Search "agent" returns ≥ 1 result.
  - Export, then import into a fresh profile: the stash is restored.
  - **No network:** track every request in the context and the service worker (`context.on('request')` + `serviceWorker.on('request')` where available, plus `chrome.webRequest` is NOT used). Assert that every request URL is either `chrome-extension://<id>/…` or `http://127.0.0.1:<port>/…` (the test pages). There must be zero requests to any other host, especially `cdn.jsdelivr.net` and `huggingface.co`.
  - **Performance:** with 500 tabs (20 windows × 25), the time from the last tab load to queue-empty is < 15 s. Log the timing.
- [ ] **Step 2:** Run `npm run build && npx playwright test` → PASS. Fix and re-run until green.
- [ ] **Step 3:** Commit `test: e2e extension flows, zero-network assertion, perf`.

### Task 16: Release packaging & security gate

**Files:**
- Create: `scripts/package.mjs`, `scripts/verify-release.mjs` (fill in), `README.md` (install from source, load unpacked in Edge/Chrome, privacy summary), `store/listing.md` (name placeholder, short/long description, permission justifications, privacy answers)

**`verify-release.mjs` fails on any of:**
- a manifest permission/CSP drift vs Global Constraints
- any `http://`/`https://` literal in `dist/**/*.js`, except an allowlist of known library comments, doc URLs and the HF strings disabled by config. The allowlist is printed, and each entry must be justified.
- a model file hash mismatch
- `innerHTML` in `dist` app chunks (lib chunks are reported only)
- package size ≥ 45 MB

**`package.mjs`:** runs verify, then zips `dist/` → `release/tab-organizer-<version>.zip`.

- [ ] **Step 1:** Implement the scripts; run `npm audit --omit=dev` (no high/critical) and `npx license-checker --production --onlyAllow "MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;0BSD"`.
- [ ] **Step 2:** Run `npm run lint && npm test && npm run test:quality && npm run build && npx playwright test && npm run package` → all PASS; the zip exists and is < 45 MB.
- [ ] **Step 3:** Run a code review (`/code-review` / superpowers:requesting-code-review) focused on security: message sender checks, URL opening, import, rendering, permissions. Fix the findings.
- [ ] **Step 4:** Commit `chore: release packaging and security gate`. Hand off to the owner, who loads `dist/` unpacked in Edge (`edge://extensions` → Developer mode → Load unpacked).
