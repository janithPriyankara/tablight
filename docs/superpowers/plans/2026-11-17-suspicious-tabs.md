# Suspicious Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Point out ad, scam and malware tabs that opened in the background, with plain reasons, a "!" toolbar badge and a confirmed, undoable Close all.

**Architecture:** A pure rules module (`suspicious.ts`) turns an item plus its local tab context into clues and a verdict. A small store (`tab-context.ts`) records the opener's site, pop-up windows and kept tabs in `chrome.storage.session`. The background adds the list to `DashboardState` and the badge. The dashboard, side panel and popup render it.

**Tech Stack:** TypeScript, Chrome MV3 APIs, Preact, Vitest (`npm test` = `vitest run tests/unit`, `npm run test:quality`), ESLint.

**Spec:** `docs/superpowers/specs/2026-11-17-suspicious-tabs-design.md`

## Global Constraints

- No new permissions (manifest stays: tabs, storage, unlimitedStorage, alarms, offscreen, favicon, sidePanel, optional tabGroups). No `notifications`, no `webNavigation`, no host permissions.
- Zero network requests. All rules bundled in source.
- Rule: a tab is suspicious when it has **at least one content clue (address or title) and at least two clues in total**.
- Only open or sleeping web tabs (`classifiable`, not `stashed`, `tabId` set) are checked.
- Opener, pop-up and kept data live only in `chrome.storage.session`. They are never synced, exported or added to sessions.
- Tablight never closes a tab by itself. Close is always user-clicked; Close all confirms first. Both go through the existing `close` RPC, which returns an undo token.
- Copy: plain and calm. Tablight's own words never say "malware", "virus" or "danger". The intro line is exactly: "These tabs opened in the background and look like ads or scams. Tablight never closes tabs on its own."
- Setting `suspiciousTabs: boolean`, default `true`. Settings switch label: "Point out suspicious tabs".
- No system notifications.

## Review Focus

1. **Opener closes before it can be looked up** (pop-unders often close their opener). Expect no error and the opener clue false. Test in Task 3.
2. **Non-web and Tablight's own pages** (`chrome://`, `edge://`, `data:`, `chrome-extension://`) are never flagged, even when the title matches. Test in Task 1.
3. **A flagged tab navigates to a normal site.** The flag disappears, and a "Keep" on it is dropped when its domain changes. Tests in Tasks 1 and 3.
4. **Same-site opener** (a search result opening another page on the same site) gives no opener clue. Test in Task 1.
5. **Setting turned off.** No suspicious list in state, and the badge returns to duplicate counts. Test in Task 4.

---

### Task 1: Clue rules

**Files:**
- Create: `src/shared/clues.ts` (types and `CLUE_TEXT`, importable by the UI), `src/background/suspicious.ts` (the rules)
- Test: `tests/unit/suspicious.test.ts`

**Interfaces:**
- Consumes: `Item` (`src/shared/types.ts`), `domainOf` and `isWebUrl` (`src/shared/url.ts`, or wherever tab-index imports them from).
- Produces (the first four in `src/shared/clues.ts`, the functions in `src/background/suspicious.ts`):
  - `export type Clue = 'opener' | 'popup' | 'unseen' | 'address' | 'title'`
  - `export interface TabContext { openerDomain?: string; popup: boolean }`
  - `export interface SuspiciousTab { item: Item; clues: Clue[] }`
  - `export const CLUE_TEXT: Record<Clue, string>`, which is exactly `{ opener: 'Opened by another site', popup: 'Opened in a pop-up window', unseen: 'Never viewed', address: 'Ad-click address', title: 'Scam-style title' }`
  - `export function addressClue(url: string): boolean`
  - `export function titleClue(title: string): boolean`
  - `export function cluesFor(item: Item, ctx: TabContext | undefined): Clue[]`, which returns clues in the order opener, popup, unseen, address, title
  - `export function isSuspicious(clues: Clue[]): boolean`
  - `export function findSuspicious(items: Item[], ctx: Map<number, TabContext>, kept: Map<number, string>): SuspiciousTab[]`. It skips tabs whose `kept.get(tabId) === item.domain` and sorts by `lastActiveAt` descending.

- [ ] **Step 1: Write the failing tests** in `tests/unit/suspicious.test.ts`, with a small `item(over: Partial<Item>)` helper:
  - `addressClue` is true for `https://official-app.space/click?key=abc123&visitor_id=987`, `http://185.23.4.10/landing`, `https://xn--pypal-4ve.com/login` and `https://track.example.top/redirect?clickid=x1&zoneid=55`.
  - `addressClue` is false for `https://github.com/user/repo/issues?q=click`, `https://www.google.com/search?q=deposit+bonus`, `https://docs.python.org/3/library/` and `https://news.ycombinator.com/item?id=1`.
  - `titleClue` is true for "Congratulations! You won an iPhone 17", "Open an envelope and reveal your 100% deposit bonus", "WARNING: Your PC is infected with 5 viruses" and "Call Microsoft Support now".
  - `titleClue` is false for "How to claim a tax deduction", "Bonus episode: Rust async", "Microsoft Support – Windows help" and "Virus taxonomy - Wikipedia".
  - `cluesFor` returns:
    - with ctx `{openerDomain: 'news.example.com', popup: false}` and an item on `official-app.space` that has `opened: false` and the click URL: `['opener','unseen','address']`;
    - with an opener on the same domain: no `'opener'`;
    - with `opened` undefined: no `'unseen'`.
  - `isSuspicious`:
    - `['opener','unseen']` → false (Ctrl-click case);
    - `['title']` → false;
    - `['address','title']` → true;
    - `['unseen','address','title']` → true (Edge gambling tab);
    - `['popup','title']` → true.
  - `findSuspicious`:
    - skips an item with `url: 'chrome://settings'` whose title is "You won a prize";
    - skips `state: 'stashed'`;
    - skips a kept tab while its domain matches;
    - includes it again when `kept` holds a different domain;
    - an item that was flagged no longer appears once its URL and title become normal.

- [ ] **Step 2: Run** `npx vitest run tests/unit/suspicious.test.ts`. Expect FAIL (module not found).

- [ ] **Step 3: Implement** the interfaces above.
  - **Address patterns:**
    - a click/redirect path segment (`/click`, `/redirect`, `/go/`, `/r/`, `/out`) together with at least one click-id style query key (`key`, `visitor_id`, `clickid`, `click_id`, `zoneid`, `campaign_id`, `subid`, `cid`, `pubid`, `bid`);
    - OR an IPv4 or IPv6 literal host;
    - OR a host label starting `xn--`;
    - OR a host on the TLD list `space, top, xyz, click, buzz, rest, cfd, sbs, icu` together with a click-style path or query key.
  - **Title patterns:** whole phrases, case-insensitive, run on `cleanTitle`-free raw title:
    - prize: "you (have )?won", "you have been selected", "claim your (prize|reward|gift)", "congratulations.{0,20}(winner|won|selected)";
    - gambling: "deposit bonus", "free spins", "reveal your .{0,20}bonus";
    - fake alert: "your (pc|computer|device|phone) (is|has been) (infected|locked|hacked)", "\d+ viruses", "virus(es)? (detected|found)", "call (microsoft|apple|windows) support";
    - fake update: "update your (flash|browser|video) player", "your browser is out of date".

- [ ] **Step 4: Run** `npx vitest run tests/unit/suspicious.test.ts`. Expect PASS.

- [ ] **Step 5: Commit** with `git commit -m "feat: suspicious-tab clue rules"`.

### Task 2: False-alarm and catch measurement

**Files:**
- Create: `tests/quality/suspicious.test.ts`, `tests/quality/spam-fixture.json`
- Modify: `tests/quality/README.md` (one paragraph describing both)

**Interfaces:**
- Consumes: `addressClue` and `titleClue` from Task 1. Corpus files: `tests/quality/fixture.json`, `holdout.json`, `holdout2.json` and `training/train-a.json` to `train-d.json`. Inspect their row shape; each row carries a title and a URL.

- [ ] **Step 1: Write `spam-fixture.json`**: about 40 rows of `{ "title": string, "url": string }` covering ad-click redirect pages, gambling bonus pages, fake virus alerts, fake updates, prize pages and pop-under landing pages. Make them realistic shapes on made-up domains, with no real brands as the scam operator.

- [ ] **Step 2: Write tests**:
  - "no normal tab has both an ad-click address and a scam title": over every corpus row, `addressClue(url) && titleClue(title)` is false. Print the counts of rows where either fires alone.
  - "catches most spam-fixture tabs on content alone": print the share with both clues and the share with at least one. Assert at least one clue fires on ≥ 80% of rows (with any behaviour clue, those are flagged).

- [ ] **Step 3: Run** `npm run test:quality -- suspicious`. Expect PASS. If the normal-corpus test fails, tighten the patterns in Task 1's module (and add the offending row to Task 1's negative tests), not the test.

- [ ] **Step 4: Commit** with `git commit -m "test: measure suspicious-tab false alarms and catch rate"`.

### Task 3: Local tab context store

**Files:**
- Create: `src/background/tab-context.ts`
- Modify: `src/background/index.ts`: in the existing `chrome.tabs.onCreated` listener, call `recordCreated(tab)`; in `onRemoved`, call `forgetTab(tabId)`.
- Test: `tests/unit/tab-context.test.ts` (use the chrome mock the other unit tests use).

**Interfaces:**
- Consumes: `TabContext` from Task 1, `domainOf`.
- Produces:
  - `export async function recordCreated(tab: chrome.tabs.Tab): Promise<void>`: if `tab.openerTabId` is set, `chrome.tabs.get(opener)` and store its URL's domain. On error (the opener is gone), store nothing.
  - `export async function loadContexts(tabs: { tabId: number; windowId?: number }[]): Promise<Map<number, TabContext>>`: `popup` comes from a per-window-id cache filled by `chrome.windows.get(id)` (`type === 'popup'`). A failed lookup counts as false and is not cached.
  - `export async function keepTab(tabId: number, domain: string): Promise<void>`
  - `export async function loadKept(): Promise<Map<number, string>>`
  - `export async function forgetTab(tabId: number): Promise<void>`: drops both the context and the kept entry.
- Session-storage keys: `suspOpeners` (`Record<tabId, domain>`), `suspPopupWindows` (`Record<windowId, boolean>`), `suspKept` (`Record<tabId, domain>`).

- [ ] **Step 1: Write tests**:
  - The opener domain is recorded and returned by `loadContexts`.
  - `chrome.tabs.get` rejects → no throw, and `openerDomain` is undefined.
  - A window of type `popup` gives `popup: true`, and `chrome.windows.get` is called once per window id across two calls.
  - `keepTab`/`loadKept` round-trip.
  - `forgetTab` removes both the context and the kept entry.

- [ ] **Step 2: Run** `npx vitest run tests/unit/tab-context.test.ts`. Expect FAIL.

- [ ] **Step 3: Implement.** Write session storage with read-modify-write per key. Wrap every `chrome.*` call so errors are swallowed; this is best-effort data.

- [ ] **Step 4: Run** `npx vitest run tests/unit/tab-context.test.ts`, then `npm test`. Expect PASS.

- [ ] **Step 5: Commit** with `git commit -m "feat: record tab opener and pop-up windows locally"`.

### Task 4: Background wiring: state, setting, keep RPC, badge

**Files:**
- Modify: `src/shared/types.ts`:
  - add `suspiciousTabs: boolean` to `Settings`;
  - add `suspiciousTabs: true` to `DEFAULT_SETTINGS`;
  - add `suspicious: SuspiciousTab[]` to `DashboardState` (type imported from `src/shared/clues.ts`).
- Modify: `src/shared/rpc.ts`: add `{ t: 'keepTab'; id: string }` to `Req` and `REQ_TYPES`.
- Modify: `src/background/index.ts`:
  - add `'suspiciousTabs'` to the settings key list (line ~257) and the boolean case (line ~287);
  - `dashboardState` computes `suspicious` (an empty array when the setting is off);
  - the `keepTab` case looks up the item and calls `keepTab(item.tabId, item.domain)`, then `notifyChanged()` and a badge refresh.
- Modify: `src/background/duplicates.ts`: `updateBadge` also takes the suspicious count.
- Test: `tests/unit/duplicates.test.ts`, `tests/unit/settings-rpc.test.ts`, `tests/unit/background-index.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 3.
- Produces:
  - `DashboardState.suspicious: SuspiciousTab[]` (built from the same item list `dashboardState` uses, after `isClutterTab` filtering);
  - the `keepTab` RPC;
  - exported `BADGE_ALERT_COLOR = '#c2410c'`.

**Badge rule:**
- While the suspicious count is > 0, every live tab's badge text is `'!'`, the background colour is `BADGE_ALERT_COLOR`, and `chrome.action.setTitle({ title: 'Tablight: N suspicious tab(s)' })` uses `plural`.
- At 0, it falls back to today's duplicate text, `BADGE_COLOR`, and a title of `'Tablight'`.
- The existing `shown` cache keeps writes minimal; the colour is only set when the mode changes.

- [ ] **Step 1: Write tests**:
  - `updateBadge` with one suspicious tab sets `'!'` on every tab and the alert colour; with none, `'2×'` returns on duplicate tabs.
  - The settings RPC accepts `suspiciousTabs: false`, and a non-boolean value is rejected.
  - `dashboardState` gives `suspicious: []` when the setting is off, even with a matching tab, and gives one entry when it is on.
  - The `keepTab` RPC removes the tab from the next `state`.

- [ ] **Step 2: Run** the three test files. Expect FAIL.

- [ ] **Step 3: Implement.** Older stored settings get the default through the existing `{ ...DEFAULT_SETTINGS, ...stored }`.

- [ ] **Step 4: Run** `npm test && npm run lint`. Expect PASS.

- [ ] **Step 5: Commit** with `git commit -m "feat: suspicious tabs in state, badge and settings"`.

### Task 5: User interface

**Files:**
- Modify: `src/ui/dashboard/views.ts` (add `'suspicious'` to `SPECIAL_VIEWS`, after `'duplicates'`), `src/ui/dashboard/Dashboard.tsx`, `src/ui/dashboard/Settings.tsx`, `src/ui/sidepanel/SidePanel.tsx`, `src/ui/popup/Popup.tsx`, and the matching CSS files.
- Test: `tests/unit/ui-dashboard.test.tsx`, `tests/unit/ui-sidepanel.test.tsx`, `tests/unit/ui-popup.test.tsx`

**Interfaces:**
- Consumes: `DashboardState.suspicious`, `CLUE_TEXT` from `src/shared/clues.ts`, the `keepTab` and `close` RPCs, and the existing undo toast and `Modal` confirm flow used by "Close duplicates".

**Exact copy:**

| Element | Text |
|---|---|
| View label | `Suspicious` |
| Intro line | as in Global Constraints |
| Reasons | `CLUE_TEXT` values joined with `' · '` |
| Row buttons | `Go to tab`, `Keep`, `Close` |
| Header button | `Close all (N)` |
| Confirm title | `Close N suspicious tab(s)?` (via `plural`), listing the titles |
| Confirm button | `Close tabs` |
| Empty view | `No suspicious tabs.` |
| Popup line | `N suspicious tab(s)` with a `Review` button that opens `#view=suspicious` |
| Side-panel heading | `Suspicious (N)` |

- The sidebar entry is shown only when N > 0, or while that view is selected.
- The side-panel section shows the same rows and Close all, at the top, only when N > 0.
- The Settings switch is labelled `Point out suspicious tabs`. It goes in the existing switches section, with helper text "Flags background tabs that look like ads or scams. Nothing is closed without your click."

- [ ] **Step 1: Write tests**:
  - With a state holding one suspicious tab:
    - the dashboard sidebar shows "Suspicious" with the count 1;
    - the view lists the reasons text;
    - "Close all (1)" opens a confirmation, and confirming sends `{t:'close', ids:[id]}`;
    - "Keep" sends `{t:'keepTab', id}`.
  - With zero: no sidebar entry, and the side-panel section is absent.
  - The popup shows "1 suspicious tab" and Review.
  - The Settings switch sends `{t:'settings', patch:{suspiciousTabs:false}}`.

- [ ] **Step 2: Run** the three UI test files. Expect FAIL.

- [ ] **Step 3: Implement**, reusing ItemGrid row styles and existing button classes. No new colours except the existing danger style for the Close buttons.

- [ ] **Step 4: Run** `npm test && npm run lint`. Expect PASS. Check visually in `npm run preview:ui` (add a mock suspicious tab to `src/ui/mock` so the preview shows the view).

- [ ] **Step 5: Commit** with `git commit -m "feat: Suspicious view, side panel section and popup link"`.

### Task 6: Docs, build and real-browser check

**Files:**
- Modify:
  - `public/privacy.html`: one paragraph under what is stored, saying which site opened a tab and whether a window is a pop-up are kept in the browser's session memory only, cleared when the browser closes, and never sent anywhere;
  - `store/listing.md`: one feature line, "Points out tabs that opened in the background and look like ads or scams, so you can close them in one click.";
  - `docs/superpowers/specs/2026-11-16-tab-organizer-design.md`: a §12 bullet linking the new spec.

- [ ] **Step 1: Edit the three docs.**
- [ ] **Step 2: Run** `npm test && npm run test:quality && npm run lint && npm run build && npm run package`. Expect all to pass, verify-release OK and the zip rebuilt.
- [ ] **Step 3: Check in Chrome for Testing** with the built `dist`, in a fresh profile with no account sign-in:
  - from a normal tab, open a local test page that calls `window.open` to a page titled "Reveal your deposit bonus" at a `/click?key=1&visitor_id=2` path (the local static server is fine; the IP-host clue will also fire);
  - confirm the badge shows "!", the Suspicious view lists it with reasons, Keep hides it, and Close all asks, closes it and Undo restores it.
- [ ] **Step 4: Commit** with `git commit -m "docs: suspicious tabs in privacy policy and listing"`.
