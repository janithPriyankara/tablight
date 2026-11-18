# Settings Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the dashboard's Settings page into four tabs with much less text on screen.

**Architecture:** The open tab lives in the hash (`#view=settings&tab=<id>`), parsed in `views.ts`; `Dashboard` keeps it
in state next to `view` and passes it to `Settings`, which renders a WAI-ARIA tablist and only the open panel.
Fine print moves into `<details>` disclosures. No setting's behaviour or stored value changes.

**Tech Stack:** Preact + TypeScript, Vitest + Testing Library (unit), Playwright (e2e), plain CSS with theme tokens.

**Spec:** `docs/superpowers/specs/2026-11-18-settings-tabs-design.md`

## Global Constraints

- Tab ids and labels, in order: `general` "General", `sync` "Sync & backup", `privacy` "Privacy & data", `help` "Help & about". Default `general`.
- Renamed: "Memory" → "Tabs and memory"; "Mirror groups as browser tab groups" → "Show groups as tab groups in the tab strip"; "Look and browser" → "Appearance".
- On Settings, the welcome card and the Close duplicates / Re-group everything buttons are not shown.
- Nothing is deleted from the copy: long text moves into a `<details>` ("More about sync"), it is not removed.
- Colours only from existing CSS tokens (`--accent`, `--border`, `--danger`…), light and dark.

## Review Focus

- An unknown or missing `tab=` value (old bookmark `#view=settings`, `tab=xyz`) → opens General, no error.
- The sidebar "Settings" button while on another tab → goes to General (it writes `view=settings`).
- Back button after switching tabs → returns to the previous tab, not out of Settings.
- Keyboard: ←/→ (and Home/End) on the tablist move between tabs and focus the new tab; only the open tab is in Tab order.
- e2e `h.reset()` (fixtures/ui.ts) uses Settings → Delete all data: it must open the Privacy & data tab first, or every e2e file breaks.

---

### Task 1: Settings tab routing

**Files:**
- Modify: `src/ui/dashboard/views.ts`
- Test: `tests/unit/ui-dashboard.test.tsx` (new `it` next to the parseUndoHash test)

**Interfaces:**
- Produces: `SETTINGS_TABS: readonly [{ id: 'general', label: 'General' }, …]` (order above), `type SettingsTab = 'general' | 'sync' | 'privacy' | 'help'`,
  `parseSettingsTab(hash: string): SettingsTab`, `settingsHash(tab: SettingsTab): string` → `'view=settings'` for general, else `` `view=settings&tab=${tab}` ``.

- [ ] **Step 1: Failing test** `settings tabs: parsed from the hash, unknown values fall back to General`:
  `parseSettingsTab('#view=settings&tab=sync') === 'sync'`, `('#view=settings') === 'general'`, `('#view=settings&tab=xyz') === 'general'`,
  `settingsHash('general') === 'view=settings'`, `settingsHash('privacy') === 'view=settings&tab=privacy'`,
  and `parseHash('#view=settings&tab=sync')` still equals `{ kind: 'settings' }`.
- [ ] **Step 2:** run `npx vitest run tests/unit/ui-dashboard.test.tsx -t "settings tabs"`: FAIL (not exported).
- [ ] **Step 3:** implement in `views.ts`.
- [ ] **Step 4:** same command: PASS.

### Task 2: Tabbed, trimmed Settings page

**Files:**
- Modify: `src/ui/dashboard/Settings.tsx`, `src/ui/dashboard/Dashboard.tsx`, `src/ui/dashboard/dashboard.css`
- Test: `tests/unit/ui-dashboard.test.tsx` (new test + existing Settings tests updated)

**Interfaces:**
- Consumes: Task 1 exports.
- Produces: `SettingsProps` gains `tab: SettingsTab; onTab: (t: SettingsTab) => void`. Tablist `role="tablist"` named "Settings sections";
  each tab `role="tab"` with its label, `aria-selected`, `aria-controls`; panel `role="tabpanel"` labelled by its tab. Sections keep
  `<section aria-labelledby>` regions with names "Grouping", "Tabs and memory", "Appearance", "Sync and backup", "Privacy", "Delete all data", "About", "Help".
  Disclosure `<details><summary>More about sync</summary>` holds the Edge/Chrome, 30-day and backup-contents paragraphs.

- [ ] **Step 1: Failing test** `settings: four tabs; General first; switching writes the hash; arrows move between tabs; Back returns`:
  render at `#view=settings`; tablist has tabs `['General','Sync & backup','Privacy & data','Help & about']`; General `aria-selected="true"`;
  `getByRole('checkbox', { name: /Create new groups automatically/ })` present and `queryByRole('button', { name: 'Export backup' })` null;
  click "Sync & backup" → `location.hash === '#view=settings&tab=sync'` and Export backup present; `keyDown(ArrowRight)` on the selected tab →
  "Privacy & data" selected and focused, Delete all data present; `End` → "Help & about"; `Home` → "General";
  `getByRole('checkbox', { name: 'Show groups as tab groups in the tab strip' })` exists on General;
  no `region` named "Welcome to Tablight" and no "Re-group everything" button while on Settings (state with `onboarded: false`).
- [ ] **Step 2:** run it: FAIL.
- [ ] **Step 3:** `Dashboard.tsx`: `settingsTab` state from `parseSettingsTab(location.hash)` (also set in the existing `onHash`);
  `onTab` assigns `location.hash = settingsHash(t)`; pass `tab`/`onTab` to `Settings`; render `Onboarding` and the toolbar's Close duplicates /
  Re-group buttons only when `view.kind !== 'settings'` (the help ? button stays).
- [ ] **Step 4:** `Settings.tsx`: tablist (roving tabindex, ←/→/Home/End wrap) and one panel per tab with the sections above; one short help
  line per setting (e.g. auto-create: "Makes a group when 3 or more unsorted tabs share a topic."; auto-pause: "Paused tabs stay in your tab
  strip and use no memory."; sync: "Saved tabs and the examples you taught your groups."); the long texts go into the sync `<details>`;
  Privacy panel: one privacy sentence + policy link, then a `.danger-zone` box with Delete all data and its existing explanation.
- [ ] **Step 5:** `dashboard.css`: `.settings-tabs` strip (underline on the selected tab with `--accent`, `--border` baseline), `.settings-more`
  (details/summary), `.danger-zone` (1px `--danger` border, radius like cards).
- [ ] **Step 6:** update existing unit tests that look for controls outside General: click the right tab first, or start at
  `#view=settings&tab=<id>` (About links → `help`; import, export text, Delete all data, sync status, overlay test → `sync`/`privacy`;
  the in-app privacy text test → `privacy`; mirror → new name). Run `npx vitest run tests/unit`: all PASS.

### Task 3: e2e tests, tour and fixture

**Files:**
- Modify: `tests/e2e/fixtures/ui.ts:189`, `tests/e2e/ui-settings.spec.ts`, `tests/e2e/ui-onboarding-keyboard.spec.ts`, `tests/e2e/suspicious.spec.ts`
- Check: `src/ui/dashboard/Tour.tsx` Settings step (targets the sidebar button `[data-tour="settings"]`; text still accurate)

- [ ] **Step 1:** `reset()` and each place that reaches Sync, Privacy or Help controls clicks the tab (`getByRole('tab', { name })`) first; `openSettings(tab?)` helper in ui-settings.spec.ts.
- [ ] **Step 2:** `npm run build` then `npx playwright test tests/e2e/ui-settings.spec.ts tests/e2e/ui-onboarding-keyboard.spec.ts tests/e2e/suspicious.spec.ts --reporter=line`: all pass.

### Task 4: Verify and ship

- [ ] **Step 1:** UI preview in the built-in browser (`ui-preview` launch config): each tab, keyboard, Back, light and dark; no console errors; screenshot.
- [ ] **Step 2:** `npx vitest run tests/unit`, `npx tsc --noEmit -p .`, `npx eslint .`: clean.
- [ ] **Step 3:** commit spec + plan + code (`feat: Settings in four tabs with less text`), push `main`, `npm run build` for the unpacked `dist`.
