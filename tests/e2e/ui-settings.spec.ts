/**
 * Settings, end to end, and the combinations they change: every switch, menu and button of Settings in the BUILT
 * extension, each run through the scenario it affects (data-driven where a setting has several values). Run
 * `npm run build` first. IDs (S-…, TH-…) are rows of docs/testing/ui-test-cases.md.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { HINTS } from '../../src/ui/common/hints';
import { navButton } from './fixtures/launch';
import { PAGES, TOPIC_PAGES } from './fixtures/server';
import { Harness, backup } from './fixtures/ui';
import { VERSION } from '../../manifest.config';

let h: Harness;
// Every test resets its own state (beforeEach), so a failure does not skip the tests after it.
test.use({ actionTimeout: 20_000 });
test.beforeAll(async () => {
  h = await Harness.start();
});
test.afterAll(async () => {
  await h?.close();
});
test.beforeEach(async () => {
  await h.reset();
});

const page = () => h.dash;
const heading = () => page().getByRole('heading', { level: 1 });
const toast = () => page().locator('.toast');
const dialog = (name: string) => page().getByRole('dialog', { name });
const list = (name: string) => page().getByRole('list', { name, exact: true });
const sw = (name: RegExp) => page().getByRole('checkbox', { name });
/** A choice of a segmented control (Theme, Toolbar icon opens): the user clicks its label, the radio is hidden. */
const pick = (name: string) => page().locator('label.segment').filter({ has: page().getByRole('radio', { name, exact: true }) }).click();
const openSettings = async () => {
  await navButton(page(), 'Settings').click();
  await expect(heading()).toHaveText('Settings');
};
const page0 = PAGES[0]!;
const savedCount = async () => (await h.state()).items.filter((i) => i.state === 'stashed').length;
const serverUrls = async () => (await h.tabs()).map((t) => t.url).filter((u) => u.startsWith(h.server.origin)).sort();

// ── Memory: remove-on-open, auto-pause ──────────────────────────────────────────────────────────────────

test('S-01..S-03 memory and grouping settings: remove-on-open on/off, the auto-pause menu, create groups automatically off/on', async () => {
  // Journey: each part starts from a reset, so it checks exactly what its old test did.
  for (const [n, removeOnOpen] of [true, false].entries()) {
    if (n > 0) { await h.reset(); } // each case from a clean slate, as when it was its own test
    await test.step(`S-01 remove a saved tab when I open it = ${removeOnOpen ? 'on' : 'off'}: opening it ${removeOnOpen ? 'removes it from' : 'keeps it in'} Saved for later`, async () => {
      const url = h.url(page0.slug);
      await h.importBackup(backup({ items: [{ url, title: page0.title }] }));
      await expect(toast()).toContainText('Imported 1 tab');
      const s = sw(/Remove a saved tab from Saved for later when I open it/);
      await expect(s).toBeChecked(); // on by default
      await s.setChecked(removeOnOpen);
      await page().reload();
      await expect(s).toBeChecked({ checked: removeOnOpen }); // kept
      await navButton(page(), 'Saved for later').click();
      const row = list('Saved for later').getByRole('listitem').filter({ hasText: page0.title });
      await row.getByRole('button', { name: 'Open', exact: true }).click();
      await expect.poll(async () => (await h.tabsAt(url)).length).toBe(1);
      await page().bringToFront();
      if (removeOnOpen) await expect(row).toHaveCount(0);
      else {
        await expect.poll(async () => (await h.state()).items.filter((i) => i.url === url).map((i) => i.state).sort()).toEqual(['open', 'stashed']);
        await expect(row).toHaveCount(1);
      }
      expect(await savedCount()).toBe(removeOnOpen ? 0 : 1);
    });
  }
  await h.reset(); // a clean slate, as when this part was its own test
  await test.step('S-02 auto-pause menu: every choice is kept after a reload; Off turns it off', async () => {
    await openSettings();
    const menu = page().getByRole('combobox', { name: /Auto-pause tabs I haven’t used for/ });
    await expect(menu).toHaveValue('off');
    for (const [label, value] of [['15 minutes', 15], ['1 hour', 60], ['1 day', 1440], ['Off', null]] as const) {
      await menu.selectOption({ label });
      await expect.poll(async () => (await h.state()).settings.autoSleepMinutes).toBe(value);
      await page().reload();
      await expect(menu).toHaveValue(value === null ? 'off' : String(value));
    }
  });
  await h.reset(); // a clean slate, as when this part was its own test
  for (const [n, auto] of [false, true].entries()) {
    if (n > 0) { await h.reset(); } // each case from a clean slate, as when it was its own test
    await test.step(`S-03 create new groups automatically = ${auto ? 'on' : 'off'}: a new topic ${auto ? 'becomes a group at once' : 'is suggested first'}`, async () => {
      await openSettings();
      const s = sw(/Create new groups automatically/);
      await expect(s).not.toBeChecked();
      await s.setChecked(auto);
      await expect.poll(async () => (await h.state()).settings.autoCreateGroups).toBe(auto);
      await h.open(TOPIC_PAGES.map((p) => h.url(p.slug)));
      const topic = h.url(TOPIC_PAGES[0]!.slug);
      await expect.poll(async () => (await h.item(topic)).groupId !== null, { timeout: 60_000 }).toBe(true);
      const s1 = await h.state();
      const g = s1.groups.find((x) => x.id === s1.items.find((i) => i.url === topic)!.groupId)!;
      expect(g.suggested ?? false).toBe(!auto);
      if (auto) {
        await expect(page().locator('section.suggestions')).toHaveCount(0);
        await expect(navButton(page(), g.name)).toBeVisible();
      } else {
        await expect(page().locator('section.suggestions')).toContainText(g.name);
        // Turning the setting on accepts the suggestion that is already waiting.
        await openSettings();
        await s.check();
        await expect.poll(async () => (await h.state()).groups.find((x) => x.id === g.id)?.suggested ?? false).toBe(false);
        await expect(page().locator('section.suggestions')).toHaveCount(0);
        await expect(navButton(page(), g.name)).toBeVisible();
      }
    });
  }
});

// ── Grouping: create new groups automatically ───────────────────────────────────────────────────────────

// ── Sync ────────────────────────────────────────────────────────────────────────────────────────────────

const syncKeys = () => page().evaluate(() => chrome.storage.sync.get(null).then((o) => Object.keys(o).filter((k) => k.startsWith('v1:'))));
const popupSyncLine = async () => {
  const p = await h.openPage('popup.html');
  const text = await p.locator('.sync-line').innerText();
  await p.close();
  return text;
};
test('S-10..S-11 sync on/off through the browser account, and a recorded status read in Settings and the popup', async () => {
  for (const [n, on] of [true, false].entries()) {
    if (n > 0) { await h.reset(); } // each case from a clean slate, as when it was its own test
    await test.step(`S-10 sync ${on ? 'on' : 'off'}: status line, popup line, and whether a saved tab reaches the browser account`, async () => {
      // (Only this browser profile: real sync between two devices is a manual check.)
      await openSettings();
      const s = sw(/Sync saved tabs through my browser account/);
      await expect(s).not.toBeChecked(); // reset() ran "Delete all data", which turns sync off
      const status = page().locator('.sync-status');
      await expect(status).toHaveText('Sync is turned off');
      await expect(status).toHaveClass(/is-error/);
      expect(await popupSyncLine()).toBe('Sync is off');
      await s.setChecked(on);
      const url = h.url(page0.slug);
      await h.open([url]);
      await navButton(page(), 'All tabs').click();
      await page().getByRole('list', { name: 'All tabs' }).getByRole('listitem').filter({ hasText: page0.title })
        .getByRole('button', { name: 'Save for later' }).click();
      await expect(toast()).toContainText('Saved 1 tab for later');
      if (on) {
        // Pushed after the sync debounce (5 s).
        await expect.poll(syncKeys, { timeout: 30_000 }).not.toEqual([]);
        await openSettings();
        await expect(status).toHaveText(/^Synced 1 · last synced/);
        expect(await popupSyncLine()).toMatch(/^Saved tabs synced/);
      } else {
        // Nothing can be polled for here: give a push the full debounce (5 s) and more to (wrongly) happen.
        await page().waitForTimeout(7_000);
        expect(await syncKeys()).toEqual([]);
        await openSettings();
        await expect(status).toHaveText('Sync is turned off');
      }
    });
  }
  await h.reset(); // a clean slate, as when this part was its own test
  await test.step('S-11 sync status “too many writes” recorded by the background reads the same in Settings and the popup', async () => {
    // The status the last sync attempt recorded (only reachable on demand by writing it: rate limits are the browser's).
    await page().evaluate((v) => chrome.storage.local.set({ syncStatus: v }),
      { ok: false, reason: 'rate', message: 'Too many changes at once: retrying shortly', lastSyncAt: Date.now() - 3_600_000 });
    await openSettings();
    await page().reload();
    const status = page().locator('.sync-status');
    await expect(status).toHaveText(/^Too many changes at once: retrying shortly · last synced 1 h ago$/);
    await expect(status).toHaveClass(/is-error/);
    expect(await popupSyncLine()).toBe('Sync paused for a moment');
  });
});

// Every status → text mapping (Settings line, popup line, error styling) is a unit test (ui-dashboard / ui-popup
// "UI test S-11"). This one case proves the real path: a status the background recorded in storage.local reaches
// both pages, with its "last synced" time and the error style.
// ── Backup: export, import, malformed files ─────────────────────────────────────────────────────────────

test('S-20..S-22 backup: Export downloads the file; a cut-off file is refused; a file with bad entries imports the good ones', async () => {
  await test.step('S-20 Export backup downloads tablight-<date>.json with the saved tabs, groups and sessions', async () => {
    const url = h.url(page0.slug);
    await h.importBackup(backup({ items: [{ url, title: page0.title, group: 'Reading pile' }], groups: ['Reading pile'] }));
    await expect(toast()).toContainText('Imported 1 tab');
    const [download] = await Promise.all([
      page().waitForEvent('download'),
      page().getByRole('button', { name: 'Export backup' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^tablight-\d{4}-\d{2}-\d{2}\.json$/);
    await expect(toast()).toContainText('Backup ready');
    const json = JSON.parse(readFileSync((await download.path())!, 'utf8')) as { format: string; items: { url: string }[]; groups: { name: string }[] };
    expect(json.format).toBe('tab-organizer');
    expect(json.items.map((i) => i.url)).toEqual([url]);
    expect(json.groups.map((g) => g.name)).toContain('Reading pile');
  });
  await h.reset(); // a clean slate, as when this part was its own test
  await test.step('S-21..S-22 import: a cut-off file is refused and changes nothing; then a file with some bad entries imports the good ones', async () => {
    await openSettings();
    const picker = page().getByLabel('Import backup file');
    await test.step('S-21 cut-off JSON shows “not valid JSON” and changes nothing', async () => {
      await picker.setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from('{"format":"tab-organizer","version":1,"items":[{"url":') });
      await expect(toast()).toContainText('not valid JSON');
      expect(await savedCount()).toBe(0);
      expect((await h.state()).groups.some((g) => !g.builtIn)).toBe(false);
    });
    await test.step('S-22 the same picker then takes a file with bad entries: the good one is imported; again adds nothing', async () => {
      const good = { url: h.url(page0.slug), title: page0.title };
      const json = backup({ items: [good] }) as { items: unknown[] };
      json.items.push({ url: 'javascript:alert(1)', title: 'bad' }, { url: 42 }, 'not an item');
      await picker.setInputFiles({ name: 'good.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(json)) });
      await expect(toast()).toContainText('Imported 1 tab');
      expect(await savedCount()).toBe(1);
      // Importing the same file again adds nothing new.
      await h.importBackup(json);
      await expect(toast()).toContainText(/Imported 0 tabs/);
      expect(await savedCount()).toBe(1);
    });
  });
});

// The error text for each kind of malformed file is a unit test (import-export.test.ts "UI test S-21"), as is the
// 20 MB check before reading (ui-dashboard.test.tsx). This journey proves the real file picker → background path.
// ── Look and browser: theme, toolbar, mirror ────────────────────────────────────────────────────────────

const LIGHT_BG = 'rgb(252, 252, 251)';
const DARK_BG = 'rgb(21, 24, 26)';
const bg = (p: Page) => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
const THEMES: { theme: 'System' | 'Light' | 'Dark'; os: 'light' | 'dark'; expected: string }[] = [
  // System follows the OS; an explicit choice overrides it (here against the opposite OS mode). The other four
  // combinations add nothing: applying data-theme is a unit test (ui-dashboard / ui-popup).
  { theme: 'System', os: 'dark', expected: DARK_BG },
  { theme: 'Dark', os: 'light', expected: DARK_BG },
];
test('TH-01, S-30, S-50 look and browser: theme on every surface, the toolbar icon target, About pages', async () => {
  for (const [n, t] of THEMES.entries()) {
    if (n > 0) { await h.reset(); } // each case from a clean slate, as when it was its own test
    await test.step(`TH-01 theme ${t.theme} with the system in ${t.os} mode: dashboard, popup and side panel are ${t.expected === DARK_BG ? 'dark' : 'light'}`, async () => {
      await page().emulateMedia({ colorScheme: t.os });
      await openSettings();
      // Before the choice, the default (System) follows the OS: light here, so the light colours are checked too.
      if (t.os === 'light') await expect.poll(() => bg(page())).toBe(LIGHT_BG);
      await pick(t.theme);
      await expect(page().getByRole('radio', { name: t.theme })).toBeChecked();
      await expect.poll(() => bg(page())).toBe(t.expected);
      await page().reload();
      await expect(page().getByRole('radio', { name: t.theme })).toBeChecked();
      await expect.poll(() => bg(page())).toBe(t.expected);
      for (const path of ['popup.html', 'sidepanel.html']) {
        const p = await h.openPage(path, (pg) => pg.emulateMedia({ colorScheme: t.os }));
        await expect(p.locator('.totals')).toBeVisible();
        await expect.poll(() => bg(p), { message: path }).toBe(t.expected);
        await p.close();
      }
      await page().emulateMedia({ colorScheme: null });
    });
  }
  await h.reset(); // a clean slate, as when this part was its own test
  await test.step('S-30 toolbar icon opens: Side panel, then Popup again: the browser’s toolbar button follows, and the choice is kept', async () => {
    await openSettings();
    await expect(page().getByRole('radio', { name: 'Popup' })).toBeChecked();
    for (const [label, opens] of [['Side panel', 'sidepanel'], ['Popup', 'popup']] as const) {
      await test.step(`S-30 = ${label}`, async () => {
        await pick(label);
        await expect.poll(async () => (await h.state()).settings.toolbarOpens).toBe(opens);
        expect(await page().evaluate(() => chrome.action.getPopup({}))).toBe(opens === 'popup' ? h.ext('popup.html') : '');
        expect(await page().evaluate(() => chrome.sidePanel.getPanelBehavior())).toEqual({ openPanelOnActionClick: opens === 'sidepanel' });
        await page().reload();
        await expect(page().getByRole('radio', { name: label })).toBeChecked();
      });
    }
  });
  await h.reset(); // a clean slate, as when this part was its own test
  await test.step('S-50 About: the version, and a link opens its built page in a new tab', async () => {
    // Every link's target is a unit test (ui-dashboard.test.tsx "Settings → About links"); here one link proves
    // the pages are in the build and open in a new tab.
    await openSettings();
    await expect(page().locator('.about-name')).toHaveText(`Tablight ${VERSION}`);
    const [p] = await Promise.all([h.context.waitForEvent('page'), page().getByRole('link', { name: 'Privacy policy', exact: true }).click()]);
    await p.waitForLoadState();
    expect(p.url()).toBe(h.ext('privacy.html'));
    await expect(p.getByRole('heading', { level: 1 })).toBeVisible();
    await p.close();
    // The other pages it links to are in the build too (fetched, not opened: one new-tab check is enough).
    for (const path of ['about.html', 'support.html', 'terms.html', 'licenses.html']) {
      expect(await page().evaluate((u) => fetch(u).then((r) => r.ok), h.ext(path)), path).toBe(true);
    }
  });
});

// ── Privacy: Delete all data, then onboarding again ─────────────────────────────────────────────────────

test('S-40 Delete all data: Cancel keeps everything; confirm wipes it, sync goes off, open tabs stay, onboarding comes back', async () => {
  // Some of everything: a user group, a saved tab, a session, sync on, a hint already seen.
  const [a, b] = [PAGES[5]!, PAGES[6]!];
  await h.open([h.url(a.slug), h.url(b.slug)]);
  await h.importBackup(backup({ items: [{ url: h.url(page0.slug), title: page0.title, group: 'Reading pile' }], groups: ['Reading pile'] }));
  await expect(toast()).toContainText('Imported 1 tab');
  await sw(/Sync saved tabs/).check();
  await navButton(page(), 'Sessions').click();
  await page().getByRole('button', { name: 'Save session now' }).click();
  await expect(toast()).toContainText('Session saved');
  await navButton(page(), 'All tabs').click();
  await page().getByRole('list', { name: 'All tabs' }).getByRole('listitem').filter({ hasText: a.title }).getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(toast()).toContainText(HINTS.pause);
  await expect(navButton(page(), 'Reading pile')).toBeVisible();

  await openSettings();
  await page().getByRole('button', { name: 'Delete all data' }).click();
  let d = dialog('Delete all data?');
  await expect(d.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await d.getByRole('button', { name: 'Cancel' }).click();
  expect(await savedCount()).toBe(1);
  await page().getByRole('button', { name: 'Delete all data' }).click();
  d = dialog('Delete all data?');
  await d.getByRole('button', { name: 'Delete all data' }).click();
  await expect(toast()).toContainText('All data deleted');
  // Onboarding again, nothing saved, no user group, no session, sync off; the open tabs are still listed.
  await expect(page().getByRole('region', { name: 'Welcome to Tablight' })).toBeVisible();
  await expect(sw(/Sync saved tabs/)).not.toBeChecked();
  await expect(navButton(page(), 'Reading pile')).toHaveCount(0);
  expect(await savedCount()).toBe(0);
  expect(await serverUrls()).toEqual([h.url(a.slug), h.url(b.slug)].sort());
  await h.settle([h.url(a.slug), h.url(b.slug)]);
  await navButton(page(), 'All tabs').click();
  await expect(page().getByRole('list', { name: 'All tabs' }).getByRole('listitem')).toHaveCount(2);
  await navButton(page(), 'Sessions').click();
  await expect(page().getByText('No sessions saved yet.')).toBeVisible();
  // The one-time hints show again.
  await navButton(page(), 'All tabs').click();
  await page().getByRole('list', { name: 'All tabs' }).getByRole('listitem').filter({ hasText: b.title }).getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(toast()).toContainText(HINTS.pause);
  // Onboarding can be finished again.
  await page().getByRole('button', { name: 'Got it' }).click();
  await expect(page().getByRole('region', { name: 'Welcome to Tablight' })).toHaveCount(0);
});

// ── About ───────────────────────────────────────────────────────────────────────────────────────────────

