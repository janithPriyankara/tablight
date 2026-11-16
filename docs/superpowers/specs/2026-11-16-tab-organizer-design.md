# Tab Organizer — Design

Status: draft for approval · 2026-11-16 · Working name "Tab Organizer" (final name TBD by owner)

## 1. Intent

Many people use a new browser tab as a quick "to explore later" note: a movie to watch, a YouTube video, an AI-agents article. Over days this grows to hundreds of tabs across 5–6 windows. The results:

- You can't find the tab you *know* you opened ("there should be a tab for this somewhere").
- The same page ends up open in several windows.
- Hundreds of loaded tabs make the machine slow.
- Closing everything isn't an option, because you want to pick up tomorrow morning where you left off tonight.

Tab Organizer is a browser extension that looks at **every tab in every window**, groups the tabs **by topic using a small AI model that runs on the user's own computer**, shows how much is waiting in each group ("AI / Agents · 23 · 9 to watch"), finds duplicates, and lets the user put tabs to sleep or save them to a list so they use no memory until they're opened again.

It will be released publicly (Chrome Web Store + Microsoft Edge Add-ons) and announced on social media. That means it has to be **private and secure by design** and easy for non-technical friends to trust.

## 2. Goals

1. **See everything in one place.** One dashboard listing all open tabs from all windows plus saved ("stashed") tabs, grouped by topic.
2. **Smart grouping on the user's computer.** Grouping uses the tab's title and URL only, through an AI model bundled inside the extension. It must handle cases where the words differ but the topic is the same, e.g. "LangGraph agents tutorial" (YouTube) and "Claude Agent SDK docs" → *AI / Agents*.
3. **Watch / read counts.** Each group shows a count plus a "to watch" count (video sites) so the user can pick something for free time.
4. **Find it again.** Search across open and stashed tabs by words *and* by meaning ("that video about agent memory").
5. **Duplicates.** Detect the same page open more than once (after URL clean-up), show where each copy is, close extras in one click, and flag a new tab that duplicates an existing one.
6. **Save memory.**
   - *Sleep*: unload a tab but keep it in the tab strip.
   - *Stash*: save the tab to a list, then close it. It reopens fresh when clicked.
   - Optional auto-sleep for tabs not used for N minutes.
7. **Continue tomorrow.** Saved snapshots of all windows, with a restore that doesn't load hundreds of tabs at once.
8. **Learn from the user.** Moving a tab to another group teaches the model. Users can create, rename, merge and delete groups.
9. **Sync and backup.** Stashed tabs sync through the browser's own account: Microsoft account in Edge, Google account in Chrome. Users can also export and import a JSON file for backup or moving between browsers.

## 3. Non-goals

- Mobile browsers. Mobile Edge and Chrome mostly can't run extensions.
- Firefox and Safari in v1. The code should not block a later Firefox port.
- Any server, account system, login, or analytics run by us.
- Reading page content. Only the title, URL and favicon that the browser already exposes are used.
- Cloud AI (Gemini API, OpenAI, etc.) or the browser's built-in AI, which is still a preview in Edge.

## 4. Anti-goals (failure even if it "works")

- Any tab title or URL leaving the user's computer, except the browser's own sync of stashed tabs, which the user can switch off.
- Downloading or running code from the internet after install.
- Broad permissions such as "read and change all your data on all websites", content scripts, or host permissions.
- Losing a user's tabs: a stash, close, import or restore that silently drops data.
- Making the browser slower: heavy work blocking the UI, or the model loaded permanently in memory.
- Grouping that feels random. Wrong groups the user can't fix are worse than no groups.

## 5. Constraints

- **Platform:** Manifest V3, Chromium (Edge ≥ 120, Chrome ≥ 120), Windows and macOS. The owner uses Edge everywhere and most friends use Chrome; both must work from one codebase.
- **Store policy:** no remote code, a minimal permission set, and a privacy policy page.
- **Sync limits:** `chrome.storage.sync` allows about 100 KB in total, 8 KB per item and 512 items, with write-rate limits. It can't hold everything, so sync is compact and has a cap.
- **Scale target:** 1,000 open tabs plus 5,000 stashed items stay responsive. Grouping 500 new tabs finishes in under about 15 s on a mid-range laptop, in the background.
- **Download size:** the extension package should stay under about 45 MB, with the model about 23 MB of that.

## 6. Approaches considered (classification)

| Approach | Trade-off | Decision |
|---|---|---|
| **A. Small embedding model bundled in the extension** | Works in Edge and Chrome on ordinary laptops, offline and private. Good at grouping, weak at writing group names. | **Chosen by owner** |
| B. Browser built-in AI (Gemini Nano / Phi-4-mini) | Nicer names, but Chrome needs about 22 GB free disk plus a strong GPU or 16 GB RAM, and in Edge it is only a Canary/Dev preview. | Not in v1; could be an optional extra later |
| C. Cloud API with the user's own key (e.g. Gemini free tier) | Smartest, but sends every title and URL to a third party, needs a key, and has rate limits. | Rejected (breaks the privacy anti-goal) |

### Model choice (research 2026-11-16)

| Model | Size (int8 ONNX) | License | Notes |
|---|---|---|---|
| **all-MiniLM-L6-v2** (`Xenova/all-MiniLM-L6-v2`) | **23 MB** + 0.7 MB tokenizer | Apache-2.0 | Most widely used small sentence model (4.5M downloads/month); 384-dim; good for clustering short text. **Pick.** |
| bge-small-en-v1.5 | 34 MB | MIT | Slightly better retrieval scores, 50% larger. Backup option. |
| potion-base-8M (Model2Vec) | 30 MB fp32 (≈8 MB if quantized) | MIT | Static embeddings: near-instant and pure JS with no WASM, but noticeably weaker. Fallback for very slow machines. |
| multilingual-MiniLM-L12 / e5-small | 118 MB | Apache/MIT | Needed for non-English titles. Too large for v1; consider as an optional download later. |

**Decision (builder's call, open to owner):** all-MiniLM-L6-v2, int8 quantized. It runs with **Transformers.js 4.x** (`@huggingface/transformers`, which uses onnxruntime-web WASM). The model files, tokenizer and WASM are **bundled in the package**, and remote model loading is disabled (`env.allowRemoteModels = false`). Mostly English titles are expected. Non-English titles still group reasonably by domain plus keyword rules, but not by meaning.

## 7. How it works

### 7.1 Components

```
┌──────────── Extension ─────────────────────────────────────────┐
│ background service worker                                      │
│   • listens to tabs/windows events, keeps the index current    │
│   • duplicate detection, auto-sleep (alarms), snapshots        │
│   • storage (IndexedDB local, storage.sync for stash)          │
│ offscreen document (only while classifying)                    │
│   • Transformers.js + MiniLM → 384-d embeddings                │
│   • closed after ~60 s idle so the model leaves memory         │
│ popup (toolbar)  — summary, dup alert, search, quick actions   │
│ dashboard (full extension page) — groups, drag-drop, stash,    │
│   sessions, settings, import/export                            │
└────────────────────────────────────────────────────────────────┘
```

- The offscreen document (reason `WORKERS`) hosts the model, so a service-worker shutdown never interrupts inference and the model can be unloaded when idle. Embeddings are cached per normalized URL+title in IndexedDB, so each page is embedded once.

### 7.2 Data (IndexedDB, local)

- `items`: `{ id, url, normUrl, title, domain, faviconKey, state: open|sleeping|stashed, tabId?, windowId?, groupId, groupSource: auto|user, kind: watch|read|other, embedding (Float32[384]), createdAt, lastActiveAt, stashedAt? }`
- `groups`: `{ id, name, color, icon, builtIn, exemplars: Float32[384][] (≤ 50), centroid, createdAt }`
- `snapshots`: `{ id, takenAt, windows: [{ tabs: [{url,title}] }] }` (last 14 kept)
- `settings`: auto-sleep minutes, snapshot schedule, sync on/off, theme.

### 7.3 Grouping

1. **Text for the model:** `title + " — " + readable domain + path words`. For example `youtube.com/watch` becomes "YouTube video"; `github.com/org/repo` becomes "GitHub repository org repo".
2. **Built-in starter groups** (Movies, TV Series, YouTube / Videos, AI & Agents, Programming, Design, Shopping, News, Social, Music, Learning / Courses, Docs & Reference, Work Tools, Travel, Finance, Health, Games, Other). The seed descriptions only set each group's centroid; they do not decide assignment on their own.
3. **Assign (as built):** classification is a trained logistic-regression (softmax) head over the MiniLM embeddings. It was trained on blind synthetic data (independent writers who never saw the code) plus the dev fixture, and its weights ship as JSON (`src/classify/head.json`, retrained with `npm run train:head`). On an independent blind holdout (`tests/quality/holdout.json`, measured by `tests/quality/accuracy.test.ts`) it reaches 91.3% top-1 (157/172), with a 25% false-assignment rate on `other` items. Users' own exemplars work as a single best-exemplar override (not a k-NN vote): when the cosine to the closest user-taught exemplar is at or above the tuned override similarity (0.58), that exemplar's group wins over the head. Rules (step 5) run first and user-assigned groups are never overridden. There is no confidence cutoff in practice (the head's threshold ships as 0): a tab goes to "Unsorted" when the head's top label is `other`, or when classification gave up on it.
4. **Discover new topics:** when Unsorted has ≥ 4 items, run agglomerative clustering (average link, threshold tuned). A cluster of ≥ 3 becomes a *suggested group*. It is named from its most common distinctive title words plus domain (TF-IDF over the cluster's titles), e.g. "Rust · async". The user can accept or rename it.
5. **Rules before AI** (fast and certain): a domain table maps sites like `netflix.com`/`imdb.com/title` → Movies/TV, and IMDb `type` hints when present in the title. Rules set `kind=watch` for youtube, netflix, primevideo, disneyplus, twitch, vimeo, etc.
6. **Learning:** dragging a tab to group G sets `groupSource=user`, which is never auto-changed again, and adds its embedding to G's exemplars. User-created groups start from their first item(s) as exemplars.
7. **Stability (builder's call):** once a tab has a group, it stays there. Learning, accepted suggestions and threshold changes only affect *new* and *Unsorted* tabs. A "Re-group everything" button lets the user re-run assignment on all `auto` items, never on `user` ones. It shows a preview with counts before applying.
8. Grouping is shown in the extension's dashboard. Optionally (setting, default **off**) it is mirrored into the browser's native tab groups (`tabGroups` permission) for the current window.

### 7.4 Duplicates

- **URL normalization:** lowercase host; drop `www.`; strip tracking params (`utm_*`, `fbclid`, `gclid`, `mc_eid`, `si`, `ref`, …); drop the fragment unless it looks like a route (`#/`); drop the trailing slash. For YouTube keep only `v` and `list`; drop `t` but remember it.
- On tab created/updated: if `normUrl` matches another open tab, set the toolbar badge (e.g. "2×"). The popup then shows "Already open in Window 3 — Switch / Close this one". No system notifications by default.
- The dashboard has a "Duplicates" filter with a "Close extras" button that keeps the most recently active copy. It asks for confirmation and closed tabs can be undone for 10 s.

### 7.5 Memory

- **Sleep:** `chrome.tabs.discard`. Never applied to the active, pinned or audible tab, or to tabs with unsent form input (Chromium already protects some of these).
- **Auto-sleep:** an alarm runs every 5 min and sleeps tabs inactive for > N minutes. It is **off by default** (builder's call). First-run onboarding offers to turn it on at 60 min, which avoids surprising users.
- **Stash:** save the item to IndexedDB (and sync), then `chrome.tabs.remove`. "Stash group" and "Stash window" stash many tabs at once. Opening a stashed item creates a tab and, by default, removes it from the stash (setting: keep).
- **Restore snapshot:** restores into the stash view, not as live tabs, so nothing loads until clicked. "Open all in new window" is offered with a warning above 20 tabs.

### 7.6 Continue tomorrow

- Snapshots of all windows (URL + title only) are taken hourly via alarm, on browser startup (the previous session), and on demand. The last 14 are kept.
- On startup the dashboard shows a "Last session" card if the browser didn't restore its windows. The extension decides this on `runtime.onStartup` by comparing the open tabs' `normUrl`s with the last snapshot. If fewer than 30% are present, it assumes the windows weren't restored.
- **Snapshots are separate from the stash (builder's call).** They live in their own read-only "Sessions" list, local only and never synced. A session can be opened item by item, opened all at once (warning above 20 tabs), or "Stash all" (copying its items into the stash, de-duplicated). This keeps hundreds of snapshot items out of the sync budget.

### 7.7 Search

- A single search box in the popup and the dashboard.
- **Instant word search** over title, domain and group, fuzzy and local.
- **"Meaning" results** below it: the query is embedded and ranked by cosine similarity against item embeddings. Shown once the model is ready (lazy load).

### 7.8 Sync & backup

- `chrome.storage.sync` holds the stash only, as a compact record: `[normUrl, title≤80 chars, groupName, stashedAt]`. Records are packed into ≤ 8 KB chunks under a version key, with total budget ≈ 90 KB, roughly 600–900 items.
- When the budget is reached, the oldest items stay local only, and the UI says so.
- Embeddings are never synced; they are recomputed on the other device.
- Sync is on by default with a clear toggle in settings.
- **Export / import:** JSON with a schema version.
  - Import is validated: schema check, max 20 MB, max 50,000 items, and only `http(s)` URLs are accepted.
  - Import merges by `normUrl` and never deletes existing data.
- Edge ↔ Chrome don't sync with each other; export/import is the bridge.
- **Sync semantics (builder's call):**
  - **Record id** = hash of `normUrl`.
  - **Opening or deleting a stashed item on one device** writes a tombstone (`id, deletedAt`). Tombstones are kept for 30 days, then pruned, so the item disappears on other devices too.
  - **Conflicts:** last-writer-wins *per record*, using `updatedAt`.
  - **Unknown group name** arriving from another device: the group is created locally. Items are never silently re-classified.
  - **Local-only items:** items over the budget are promoted (newest first) when space frees up.
  - **Data safety:** sync never deletes a local item unless a tombstone for it exists. Before any destructive merge, a local backup of the stash is kept, holding the last 3 merges.

### 7.9 UI

- **Popup (≈380×560):**
  - totals ("214 tabs · 6 windows · 31 sleeping · 12 duplicates")
  - a duplicate alert for the current tab
  - search
  - the top groups with counts
  - buttons: Open dashboard / Stash this window / Sleep inactive
- **Dashboard (full page):**
  - left: group list with counts and "to watch" badges, plus Duplicates, Stashed, Sessions
  - main: cards for the selected group, each with favicon, title, domain, window number, state, and actions (open/switch, sleep, stash, close, move)
  - drag-and-drop between groups and multi-select
  - light/dark theme
- Keyboard: a command (default `Alt+Shift+T`) opens the dashboard.

## 8. Security & privacy requirements

1. **Permissions:** `tabs`, `storage`, `unlimitedStorage`, `alarms`, `offscreen`, `favicon`, and optional `tabGroups`, requested only when the user turns on mirroring. **No host permissions, no content scripts, no `scripting`, no `history`, no `webRequest`.**
2. **No network:** the extension makes no network requests. CSP for extension pages: `script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self'; img-src 'self' data:`. Favicons are loaded via the browser's `_favicon/` endpoint (`favicon` permission), never fetched from websites.
3. **No remote code:** all JS, WASM and model files are in the package, and Transformers.js remote loading is disabled. Release builds record the SHA-256 of the model and WASM files, and CI checks them.
4. **Untrusted text:** tab titles and URLs are attacker-controlled. They are rendered only as text (`textContent` / framework text bindings), and `innerHTML` with dynamic data is never used (enforced by lint rule).
5. **Safe URL opening:** only `http:`, `https:` and (for open tabs) existing tab switching are allowed. `javascript:`, `data:`, `file:`, `chrome:` and `edge:` URLs are never opened from the stash or imports.
6. **Import hardening:** strict schema validation, size and count limits, prototype-pollution-safe parsing (no merging into objects with `__proto__` keys), and no eval.
7. **Supply chain:** few dependencies (Transformers.js, Preact, idb). Exact versions are pinned with a lockfile. `npm audit` and license checks run in CI. Builds are reproducible from source.
8. **Incognito:** not enabled (`"incognito": "not_allowed"`) so private tabs are never recorded.
9. **Source & policy hosting (owner decision 2026-11-16):** the source repo stays **private**. The privacy policy ships inside the extension as `privacy.html`. For the store-required URL, the same file is published in a separate tiny public repo that contains only the policy, served by GitHub Pages. The owner creates that repo at release time. "Reproducible from source" becomes an internal release check, not a public promise.
10. **Privacy policy:** a plain page saying that nothing leaves the device except the browser's own sync of stashed tabs, which the user can switch off.

## 9. Testing

- **Unit (Vitest):**
  - URL normalization
  - duplicate detection
  - sync chunking and budget
  - import validation, including malicious inputs (`javascript:` URLs, huge files, `__proto__`)
  - clustering and threshold logic
  - group naming
- **Classification quality:** a labelled fixture of ≈300 realistic tab titles and URLs across the starter groups. Target ≥ 85% top-1 accuracy on built-in groups; the threshold is tuned against it.
- **Extension end-to-end (Playwright + Chromium, loading the unpacked build):**
  - open ~50 tabs in 3 windows, check groups, duplicates, sleep, stash, restore, search, import/export
  - check that no network requests are made (request interception)
- **UI in the built-in browser:**
  - the browser pane inside the Claude desktop app can't load extensions, so the dashboard and popup are also served as plain pages with a mocked `chrome.*` API for visual and interaction checks
  - the owner then loads the real build unpacked in Edge
- **Performance:** grouping 500 tabs under ~15 s, dashboard with 1,000 items stays smooth (virtualized list).

## 10. Tech stack (builder's calls)

- TypeScript, Vite (multi-entry build for the service worker, offscreen, popup and dashboard), Preact for the UI, `idb` for IndexedDB.
- `@huggingface/transformers` 4.x with local `onnx-wasm` files, plus the `Xenova/all-MiniLM-L6-v2` int8 ONNX model files committed or fetched at **build** time with a checksum check.
- Output: `dist/` unpacked extension plus a store-ready zip. The same zip goes to the Chrome Web Store and Edge Add-ons.

## 11. Left to the builder

- Exact similarity and clustering thresholds, tuned on the fixture.
- Visual design details within the layout above.
- Group colours and icons; starter seed phrases.
- Whether embedding runs fully in the offscreen document or partly in a worker inside it.
Rulings recorded during the build that changed behaviour described above:
- **Classifier (7.3):** a trained logistic-regression head over MiniLM embeddings replaced seed-prototype matching, which topped out at 69% on the blind holdout. bge-small was tried (93.6%) and not adopted: under the 3-point bar and about 11 MB larger.
- **Sync conflict resolution (7.8):** last-writer-wins uses raw timestamps with no clamping; every stashed-record change is stamped `max(now, previous updatedAt + 1)` so a record's stamps only go up. A device with a fast clock can bias the result but no data is lost.
- **Sync encoding (7.8):** tombstones are written first and capped at 75% of the budget; items that were never synced get no tombstone. A re-stash clears the tombstone. A write-rate guard pauses sync for 15 minutes after more than 6 pull-triggered writes in 10 minutes. A device offline for more than 30 days (the tombstone lifetime) may bring back stashed tabs that were deleted elsewhere.
- **Session-safe tab matching (7.1):** a browser restart changes tab and window ids, so reconcile falls back to matching by normalized URL.
- **Startup snapshot gating (7.6):** the hourly alarm takes snapshots only after the startup check has finished (capped at 3 attempts), so a missed alarm cannot overwrite the last session before it is offered.
- **Search (7.7):** semantic search reads stored embedding keys in bulk instead of hashing every item per query.
- **Release gate:** `npm run build` ends with `scripts/verify-release.mjs` (manifest, CSP, URL literals, model and ORT hashes, DOM-injection APIs, bundled-package licenses, size under 45 MB).
