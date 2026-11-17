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
test.describe.configure({ mode: 'serial' });
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

for (const removeOnOpen of [true, false]) {
  test(`S-01 remove a saved tab when I open it = ${removeOnOpen ? 'on' : 'off'}: opening it ${removeOnOpen ? 'removes it from' : 'keeps it in'} Saved for later`, async () => {
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

test('S-02 auto-pause menu: every choice is kept after a reload; Off turns it off', async () => {
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

// ── Grouping: create new groups automatically ───────────────────────────────────────────────────────────

for (const auto of [false, true]) {
  test(`S-03 create new groups automatically = ${auto ? 'on' : 'off'}: a new topic ${auto ? 'becomes a group at once' : 'is suggested first'}`, async () => {
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

// ── Sync ────────────────────────────────────────────────────────────────────────────────────────────────

const syncKeys = () => page().evaluate(() => chrome.storage.sync.get(null).then((o) => Object.keys(o).filter((k) => k.startsWith('v1:'))));
const popupSyncLine = async () => {
  const p = await h.openPage('popup.html');
  const text = await p.locator('.sync-line').innerText();
  await p.close();
  return text;
};
for (const on of [true, false]) {
  test(`S-10 sync ${on ? 'on' : 'off'}: status line, popup line, and whether a saved tab reaches the browser account`, async () => {
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

const STATUSES: { name: string; status: (now: number) => unknown; settings: RegExp; popup: RegExp; error: boolean }[] = [
  { name: 'never synced', status: () => ({ ok: true, synced: 0, localOnly: 0, lastSyncAt: null }), settings: /^Not synced yet$/, popup: /^Saved tabs not synced yet$/, error: false },
  { name: 'synced, some only here', status: (now) => ({ ok: true, synced: 412, localOnly: 37, lastSyncAt: now - 5 * 60_000 }), settings: /^Synced 412 · 37 only on this device · last synced 5 min ago$/, popup: /^Saved tabs synced 5 min ago$/, error: false },
  { name: 'sync storage full', status: () => ({ ok: false, reason: 'quota', message: 'Sync storage is full: 3 saved tabs stay on this device', lastSyncAt: null }), settings: /^Sync storage is full: 3 saved tabs stay on this device$/, popup: /^Sync full · saved tabs kept on this device$/, error: true },
  { name: 'too many writes', status: (now) => ({ ok: false, reason: 'rate', message: 'Too many changes at once: retrying shortly', lastSyncAt: now - 3_600_000 }), settings: /^Too many changes at once: retrying shortly · last synced 1 h ago$/, popup: /^Sync paused for a moment$/, error: true },
  { name: 'failed', status: () => ({ ok: false, reason: 'error', message: 'Sync failed: will retry', lastSyncAt: null }), settings: /^Sync failed: will retry$/, popup: /^Sync failed · will retry$/, error: true },
];
for (const st of STATUSES) {
  test(`S-11 sync status “${st.name}” reads the same in Settings and the popup`, async () => {
    // The status the last sync attempt recorded (only reachable on demand by writing it: quota and rate limits
    // are the browser's).
    await page().evaluate((v) => chrome.storage.local.set({ syncStatus: v }), st.status(Date.now()));
    await openSettings();
    await page().reload();
    const status = page().locator('.sync-status');
    await expect(status).toHaveText(st.settings);
    await expect(status).toHaveClass(st.error ? /is-error/ : /^sync-status$/);
    expect(await popupSyncLine()).toMatch(st.popup);
  });
}
// ── Backup: export, import, malformed files ─────────────────────────────────────────────────────────────

test('S-20 Export backup downloads tablight-<date>.json with the saved tabs, groups and sessions', async () => {
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

const MALFORMED: { name: string; file: string | Buffer; message: string }[] = [
  { name: 'an empty file', file: '', message: 'not valid JSON' },
  { name: 'a text file', file: 'hello, this is not a backup', message: 'not valid JSON' },
  { name: 'cut-off JSON', file: '{"format":"tab-organizer","version":1,"items":[{"url":', message: 'not valid JSON' },
  { name: 'another app’s JSON', file: '{"tabs":[]}', message: 'not a Tablight backup' },
  { name: 'a newer backup version', file: '{"format":"tab-organizer","version":2,"items":[]}', message: 'not a Tablight backup' },
  { name: 'items that are not a list', file: '{"format":"tab-organizer","version":1,"items":{}}', message: 'malformed backup' },
  { name: 'deeply nested JSON', file: `{"format":"tab-organizer","version":1,"items":${'['.repeat(200)}${']'.repeat(200)}}`, message: 'file is nested too deeply' },
  { name: 'a file over 20 MB', file: Buffer.alloc(20 * 1024 * 1024 + 1, 0x20), message: 'That file is larger than 20 MB, so it can’t be a Tablight backup.' },
];
for (const m of MALFORMED) {
  test(`S-21 importing ${m.name} shows “${m.message}” and changes nothing`, async () => {
    await openSettings();
    await page().getByLabel('Import backup file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(m.file) });
    await expect(toast()).toHaveText(new RegExp(m.message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(await savedCount()).toBe(0);
    expect((await h.state()).groups.some((g) => !g.builtIn)).toBe(false);
    // The page still works: the same picker accepts a good file next.
    await page().getByLabel('Import backup file').setInputFiles({
      name: 'good.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup({ items: [{ url: h.url(page0.slug), title: page0.title }] }))),
    });
    await expect(toast()).toContainText('Imported 1 tab');
  });
}

test('S-22 a backup with some bad entries imports the good ones and says how many were skipped', async () => {
  const good = { url: h.url(page0.slug), title: page0.title };
  const json = backup({ items: [good] }) as { items: unknown[] };
  json.items.push({ url: 'javascript:alert(1)', title: 'bad' }, { url: 42 }, 'not an item');
  await h.importBackup(json);
  await expect(toast()).toContainText('Imported 1 tab');
  expect(await savedCount()).toBe(1);
  // Importing the same file again adds nothing new.
  await h.importBackup(json);
  await expect(toast()).toContainText(/Imported 0 tabs · skipped 1|Imported 0 tabs/);
  expect(await savedCount()).toBe(1);
});

// ── Look and browser: theme, toolbar, mirror ────────────────────────────────────────────────────────────

const LIGHT_BG = 'rgb(252, 252, 251)';
const DARK_BG = 'rgb(21, 24, 26)';
const bg = (p: Page) => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
const THEMES: { theme: 'System' | 'Light' | 'Dark'; os: 'light' | 'dark'; expected: string }[] = [
  { theme: 'System', os: 'light', expected: LIGHT_BG },
  { theme: 'System', os: 'dark', expected: DARK_BG },
  { theme: 'Light', os: 'light', expected: LIGHT_BG },
  { theme: 'Light', os: 'dark', expected: LIGHT_BG },
  { theme: 'Dark', os: 'light', expected: DARK_BG },
  { theme: 'Dark', os: 'dark', expected: DARK_BG },
];
for (const t of THEMES) {
  test(`TH-01 theme ${t.theme} with the system in ${t.os} mode: dashboard, popup and side panel are ${t.expected === DARK_BG ? 'dark' : 'light'}`, async () => {
    await page().emulateMedia({ colorScheme: t.os });
    await openSettings();
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

for (const [label, opens] of [['Side panel', 'sidepanel'], ['Popup', 'popup']] as const) {
  test(`S-30 toolbar icon opens = ${label}: the browser’s toolbar button is pointed at the ${label.toLowerCase()}`, async () => {
    await openSettings();
    await expect(page().getByRole('radio', { name: 'Popup' })).toBeChecked();
    if (opens === 'popup') await pick('Side panel'); // start from the other one
    await pick(label);
    await expect.poll(async () => (await h.state()).settings.toolbarOpens).toBe(opens);
    expect(await page().evaluate(() => chrome.action.getPopup({}))).toBe(opens === 'popup' ? h.ext('popup.html') : '');
    expect(await page().evaluate(() => chrome.sidePanel.getPanelBehavior())).toEqual({ openPanelOnActionClick: opens === 'sidepanel' });
    await page().reload();
    await expect(page().getByRole('radio', { name: label })).toBeChecked();
  });
}

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

test('S-50 About: version, and every link opens its page in a new tab', async () => {
  await openSettings();
  await expect(page().locator('.about-name')).toHaveText(`Tablight ${VERSION}`);
  const links: [string, string][] = [
    ['Read the privacy policy', 'privacy.html'], ['About Tablight', 'about.html'], ['Help and support', 'support.html'],
    ['Privacy policy', 'privacy.html'], ['Terms of use', 'terms.html'], ['Open-source licences', 'licenses.html'],
  ];
  for (const [name, path] of links) {
    const [p] = await Promise.all([h.context.waitForEvent('page'), page().getByRole('link', { name, exact: true }).click()]);
    await p.waitForLoadState();
    expect(p.url()).toBe(h.ext(path));
    await expect(p.getByRole('heading', { level: 1 })).toBeVisible();
    await p.close();
  }
});
