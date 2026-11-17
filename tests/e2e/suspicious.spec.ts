/**
 * Suspicious tabs, end to end: the BUILT extension (dist/) in real Chromium, operated the way a user would.
 * Run `npm run build` first.
 *
 * Hosts: the pages that open other tabs are served as http://localhost:<port> and the pages they open as
 * http://127.0.0.1:<port> (same local server), so "Opened by another site" sees two different sites. Loopback
 * hosts never count as an ad-click address by themselves; the spam page's /click?key=1&visitor_id=2 does.
 *
 * Background tabs ("Never viewed"): a real user path, not chrome.tabs.create. The opener page's button calls
 * window.open(url) and the test Ctrl/Cmd-clicks it (Playwright `modifiers: ['ControlOrMeta']`): Chromium then
 * opens the new tab in the background, with the opener recorded as its openerTabId. Each test checks that
 * the new tab really stayed inactive before relying on it.
 *
 * One browser is shared (the model warm-up is slow); every test starts from a clean slate: only the dashboard
 * tab left, the setting on, nothing suspicious.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLUE_TEXT } from '../../src/shared/clues';
import { assertBuilt, launchExtension, navButton, rpc, state } from './fixtures/launch';
import { PAGES, SUS_TITLES, startPageServer, type PageServer } from './fixtures/server';

assertBuilt();
const SETTLE_MS = 120_000;

let server: PageServer;
let context: BrowserContext;
let extId: string;
let dash: Page;
let dir: string;
/** Openers' host (localhost) and the opened pages' host (127.0.0.1): two different sites. */
let A: string;
let B: string;
const SPAM_PATH = '/click?key=1&visitor_id=2';
let SPAM: string;
let SPAM2: string;

// Every test resets its own state (beforeEach), so a failure does not skip the tests after it.

test.beforeAll(async () => {
  server = await startPageServer();
  A = `http://localhost:${server.port}`;
  B = server.origin;
  SPAM = `${B}${SPAM_PATH}`;
  SPAM2 = `${B}${SPAM_PATH}&v=2`;
  dir = mkdtempSync(join(tmpdir(), 'tab-organizer-e2e-sus-'));
  ({ context, id: extId } = await launchExtension(dir));
  dash = await context.newPage();
  await dash.goto(dashboardUrl());
  // Starter groups are built with the model on install: wait, so later index passes are quick.
  await expect.poll(async () => (await state(dash)).groups.length, { timeout: SETTLE_MS }).toBeGreaterThan(0);
});
test.afterAll(async () => {
  await context?.close().catch(() => undefined);
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const dashboardUrl = (hash = '') => `chrome-extension://${extId}/dashboard.html${hash}`;

/** Clean slate: only the dashboard tab, suspicious tabs pointed out, nothing flagged, dashboard reloaded. */
test.beforeEach(() => cleanSlate());
async function cleanSlate(): Promise<void> {
  if (dash.isClosed()) dash = await context.newPage();
  await dash.goto(dashboardUrl());
  await dash.bringToFront();
  const keep = await dash.evaluate(() => chrome.tabs.getCurrent().then((t) => t!.id!));
  await dash.evaluate(async (me) => {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.filter((t) => t.id !== me).map((t) => chrome.tabs.remove(t.id!).catch(() => undefined)));
  }, keep);
  await rpc(dash, { t: 'settings', patch: { suspiciousTabs: true } });
  await expect.poll(async () => {
    const s = await state(dash);
    return s.suspicious.length === 0 && s.items.every((i) => i.state === 'stashed' || !i.url.startsWith('http'));
  }).toBe(true);
  await expect.poll(() => actionTitle()).toBe('Tablight');
  await dash.reload();
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────

const qs = (targets: string[]) => targets.map((t) => `to=${encodeURIComponent(t)}`).join('&');

interface TabInfo { id: number; url: string; active: boolean; windowId: number; text: string }
/** Every tab with its toolbar badge text, read through the extension's own APIs. */
function tabs(): Promise<TabInfo[]> {
  return dash.evaluate(async () => {
    const all = await chrome.tabs.query({});
    return Promise.all(all.map(async (t) => ({
      id: t.id!, url: t.url ?? t.pendingUrl ?? '', active: t.active, windowId: t.windowId,
      text: await chrome.action.getBadgeText({ tabId: t.id! }),
    })));
  });
}
const tabFor = async (url: string) => (await tabs()).find((t) => t.url === url);
const actionTitle = () => dash.evaluate(() => chrome.action.getTitle({}));

/**
 * Opens `/opener` on site A in a new tab and Ctrl/Cmd-clicks its window.open button for each target, so
 * every target opens in a background tab. Waits until each one is loaded and indexed, still never viewed.
 */
async function openInBackground(targets: string[]): Promise<Page> {
  const opener = await context.newPage();
  await opener.goto(`${A}/opener?${qs(targets)}`);
  for (let n = 0; n < targets.length; n++) {
    await opener.locator(`#open${n}`).click({ modifiers: ['ControlOrMeta'] });
  }
  await waitIndexed(targets);
  for (const u of targets) expect((await tabFor(u))?.active, `${u} opened in the background`).toBe(false);
  return opener;
}
/** Waits until a tab for each URL is indexed with its real title. */
async function waitIndexed(urls: string[]): Promise<void> {
  await expect.poll(async () => {
    const s = await state(dash);
    return urls.every((u) => s.items.some((i) => i.url === u && i.tabId !== undefined && i.title !== '' && !i.title.startsWith('http')));
  }, { timeout: SETTLE_MS }).toBe(true);
}
/** The spam tab opened in the background from another site, flagged. */
async function openSpam(targets = [SPAM]): Promise<void> {
  await openInBackground(targets);
  await expect.poll(async () => (await state(dash)).suspicious.length).toBe(targets.length);
}

const susList = (p: Page) => p.getByRole('list', { name: 'Suspicious tabs' });
const susRow = (p: Page, title: string) => susList(p).getByRole('listitem').filter({ hasText: title });
const reasons = (p: Page, title: string) => susRow(p, title).locator('.item-note');
const showSuspicious = async () => {
  await navButton(dash, 'Suspicious').click();
  await expect(dash.getByRole('heading', { level: 1 })).toHaveText('Suspicious');
};
const reasonText = (...clues: (keyof typeof CLUE_TEXT)[]) => clues.map((c) => CLUE_TEXT[c]).join(' · ');

/** Every tab's badge, polled until it matches. */
async function expectEveryBadge(test: (text: string) => boolean, what: string): Promise<void> {
  await expect.poll(async () => {
    const all = await tabs();
    return all.length > 0 && all.every((t) => test(t.text)) ? 'ok' : all.map((t) => `${t.url} → "${t.text}"`).join('\n');
  }, { message: what }).toBe('ok');
}
const expectAlertBadges = () => expectEveryBadge((t) => t === '!', 'every tab reads "!"');
const expectNoAlertBadges = () => expectEveryBadge((t) => t !== '!', 'no tab reads "!"');

// ── not flagged ─────────────────────────────────────────────────────────────────────────────────────────

test('detection: what is flagged and what is not, on every surface (badge, title, sidebar, view, popup)', async () => {
  // Journey: each part starts from a clean slate, so it checks exactly what its old test did.
  await test.step('not flagged: a normal background tab from another site; a “You won’t believe…” tab opened from a link', async () => {
    // Two cases in one browser state: neither may flag anything, and together they still prove no false "!".
    await test.step('a normal background tab opened by another site', async () => {
      const article = `${B}/article`;
      await openInBackground([article]);
      // Two arrival clues (another site, never viewed) but nothing about the page itself: not suspicious.
      const s = await state(dash);
      expect(s.items.find((i) => i.url === article)?.opened).toBe(false);
      expect(s.suspicious).toEqual([]);
      await expect(navButton(dash, 'All tabs')).toBeVisible();
      await expect(navButton(dash, 'Suspicious')).toHaveCount(0);
      await expectNoAlertBadges();
      expect(await actionTitle()).toBe('Tablight');
    });
    await test.step('a “You won’t believe…” background tab opened from a link', async () => {
      const recipe = `${B}/recipe`;
      // The normal page's link, Ctrl/Cmd-clicked: a background tab opened from a link.
      const normal = await context.newPage();
      await normal.goto(`${A}/normal?${qs([recipe])}`);
      await normal.locator('#link0').click({ modifiers: ['ControlOrMeta'] });
      await waitIndexed([recipe]);
      expect((await tabFor(recipe))?.active).toBe(false);
      const s = await state(dash);
      expect(s.items.find((i) => i.url === recipe)?.title).toBe(SUS_TITLES.recipe);
      expect(s.suspicious).toEqual([]);
      await expect(navButton(dash, 'Suspicious')).toHaveCount(0);
      await expectNoAlertBadges();
    });
  });
  await cleanSlate(); // a clean slate, as when this part was its own test
  await test.step('a spam tab opened by another site and never viewed is flagged everywhere: badge, title, sidebar, view, popup → Review', async () => {
    await openSpam();
    await test.step('toolbar badge and title, sidebar entry, Suspicious view', async () => {
      await expectAlertBadges();
      expect(await actionTitle()).toBe('Tablight: 1 suspicious tab');
      await expect(navButton(dash, 'Suspicious')).toHaveText(/^Suspicious\s*1$/);
      await showSuspicious();
      await expect(dash.getByText('These tabs opened in the background and look like ads or scams. Tablight never closes tabs on its own.')).toBeVisible();
      await expect(susList(dash).getByRole('listitem')).toHaveCount(1);
      await expect(reasons(dash, SUS_TITLES.spam)).toHaveText('Opened by another site · Never viewed · Ad-click address · Scam-style title');
    });
    await test.step('popup: “1 suspicious tab” and Review really opens the dashboard at #view=suspicious', async () => {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extId}/popup.html`);
      await expect(popup.getByText('1 suspicious tab', { exact: true })).toBeVisible();
      await popup.getByRole('button', { name: 'Review' }).click();
      await expect.poll(async () => (await tabs()).some((t) => t.url === dashboardUrl('#view=suspicious'))).toBe(true);
      const page = context.pages().find((p) => !p.isClosed() && p.url() === dashboardUrl('#view=suspicious'))!;
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Suspicious');
      await expect(susRow(page, SUS_TITLES.spam)).toHaveCount(1);
    });
  });
  await cleanSlate(); // a clean slate, as when this part was its own test
  await test.step('a spam page in a pop-up window is flagged with “Opened in a pop-up window”', async () => {
    const opener = await context.newPage();
    await opener.goto(`${A}/popup-opener?${qs([SPAM])}`);
    await opener.locator('#open0').click();
    await waitIndexed([SPAM]);
    const tab = (await tabFor(SPAM))!;
    expect(await dash.evaluate((w) => chrome.windows.get(w).then((x) => x.type), tab.windowId)).toBe('popup');
    await expect.poll(async () => (await state(dash)).suspicious.length).toBe(1);
    await expectAlertBadges();
    await showSuspicious();
    await expect(reasons(dash, SUS_TITLES.spam)).toContainText(CLUE_TEXT.popup);
    // Shown in its own (focused) window, so it was viewed: the other clues are the ones the page triggers.
    await expect(reasons(dash, SUS_TITLES.spam)).toHaveText(reasonText('opener', 'popup', 'address', 'title'));
  });
  await cleanSlate(); // a clean slate, as when this part was its own test
  await test.step('a spam tab that navigates to a normal page is no longer flagged', async () => {
    await openSpam();
    await expectAlertBadges();
    const tabId = (await tabFor(SPAM))!.id;
    const article = `${B}/article`;
    await dash.evaluate(([id, url]) => chrome.tabs.update(id, { url }).then(() => undefined), [tabId, article] as const);
    await waitIndexed([article]);
    await expect.poll(async () => (await state(dash)).suspicious.length).toBe(0);
    await expectNoAlertBadges();
    await expect(navButton(dash, 'Suspicious')).toHaveCount(0);
  });
});
// ── flagged ─────────────────────────────────────────────────────────────────────────────────────────────

// ── row actions ─────────────────────────────────────────────────────────────────────────────────────────

test('dashboard row actions: Go to tab, Close with Undo, Keep (and flagged again), Close all', async () => {
  await test.step('Go to tab switches to it (“Never viewed” goes); then Close closes the tab, offers Undo, and Undo reopens it', async () => {
    await openSpam();
    await showSuspicious();
    await test.step('Go to tab', async () => {
      await expect(reasons(dash, SUS_TITLES.spam)).toContainText(CLUE_TEXT.unseen);
      await susRow(dash, SUS_TITLES.spam).getByRole('button', { name: `Go to tab ${SUS_TITLES.spam}` }).click();
      await expect.poll(async () => (await tabFor(SPAM))?.active).toBe(true);
      // Still suspicious (three clues left), now without "Never viewed".
      await expect(reasons(dash, SUS_TITLES.spam)).toHaveText(reasonText('opener', 'address', 'title'));
    });
    await test.step('Close, then Undo reopens the real tab', async () => {
      await dash.bringToFront();
      await susRow(dash, SUS_TITLES.spam).getByRole('button', { name: `Close ${SUS_TITLES.spam}` }).click();
      await expect.poll(async () => (await tabFor(SPAM)) === undefined).toBe(true);
      const toast = dash.getByRole('status').filter({ hasText: 'Closed 1 tab' });
      await expect(toast).toBeVisible();
      await toast.getByRole('button', { name: 'Undo' }).click();
      await expect.poll(async () => (await tabs()).filter((t) => t.url === SPAM).length).toBe(1);
    });
  });
  await cleanSlate(); // a clean slate, as when this part was its own test
  await test.step('Keep hides the row (also after a reload); leaving the site and coming back flags it again', async () => {
    await openSpam();
    await showSuspicious();
    const keep = susRow(dash, SUS_TITLES.spam).getByRole('button', { name: `Keep ${SUS_TITLES.spam}` });
    await expect(keep).toHaveText('Keep'); // a visible word on the dashboard (the side panel has icon buttons)
    await expect(keep.locator('.sus-btn-word')).toBeVisible();
    await keep.click();
    await expect(susRow(dash, SUS_TITLES.spam)).toHaveCount(0);
    await expectNoAlertBadges();
    await dash.reload();
    await expect(dash.getByText('No suspicious tabs.')).toBeVisible();
    await expect(susRow(dash, SUS_TITLES.spam)).toHaveCount(0);
    expect((await state(dash)).suspicious).toEqual([]);

    // The kept tab goes to another site (seen by the index), then back to the spam page.
    const tabId = (await tabFor(SPAM))!.id;
    const elsewhere = `${A}/article`;
    await dash.evaluate(([id, url]) => chrome.tabs.update(id, { url }).then(() => undefined), [tabId, elsewhere] as const);
    await waitIndexed([elsewhere]);
    await dash.evaluate(([id, url]) => chrome.tabs.update(id, { url }).then(() => undefined), [tabId, SPAM] as const);
    await waitIndexed([SPAM]);
    await expect.poll(async () => (await state(dash)).suspicious.map((s) => s.item.tabId)).toEqual([tabId]);
    await expect(susRow(dash, SUS_TITLES.spam)).toHaveCount(1);
    await expectAlertBadges();
  });
  await cleanSlate(); // a clean slate, as when this part was its own test
  await test.step('Close all with two spam tabs: confirmation lists both, Cancel keeps them, confirm closes both, Undo reopens', async () => {
    await openSpam([SPAM, SPAM2]);
    await expectAlertBadges();
    expect(await actionTitle()).toBe('Tablight: 2 suspicious tabs');
    await showSuspicious();
    await expect(susList(dash).getByRole('listitem')).toHaveCount(2);

    const closeAll = dash.getByRole('button', { name: 'Close all (2)' });
    await closeAll.click();
    let dialog = dash.getByRole('dialog', { name: 'Close 2 suspicious tabs?' });
    await expect(dialog).toBeVisible();
    // Listed most recently active first; the order between two never-viewed tabs is not the point here.
    await expect.poll(async () => (await dialog.getByRole('listitem').allInnerTexts()).sort()).toEqual([SUS_TITLES.spam, SUS_TITLES.spam2].sort());
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect((await tabs()).filter((t) => t.url === SPAM || t.url === SPAM2)).toHaveLength(2);
    await expect(susList(dash).getByRole('listitem')).toHaveCount(2);

    await closeAll.click();
    dialog = dash.getByRole('dialog', { name: 'Close 2 suspicious tabs?' });
    await dialog.getByRole('button', { name: 'Close tabs' }).click();
    await expect.poll(async () => (await tabs()).filter((t) => t.url === SPAM || t.url === SPAM2).length).toBe(0);
    // No duplicates among the tabs left (dashboard and opener): the badge is back to empty.
    await expectEveryBadge((t) => t === '', 'every badge is empty again');
    await expect.poll(() => actionTitle()).toBe('Tablight');
    const toast = dash.getByRole('status').filter({ hasText: 'Closed 2 tabs' });
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await tabs()).filter((t) => t.url === SPAM || t.url === SPAM2).map((t) => t.url).sort())
      .toEqual([SPAM, SPAM2].sort());
  });
});

test('the setting, the side panel, and the badge with duplicates', async () => {
  await test.step('the “Point out suspicious tabs” switch hides the entry and the “!” badge, and brings them back', async () => {
    await openSpam();
    await expectAlertBadges();
    await expect(navButton(dash, 'Suspicious')).toBeVisible();
    await navButton(dash, 'Settings').click();
    const sw = dash.getByRole('checkbox', { name: /Point out suspicious tabs/ });
    await expect(sw).toBeChecked();
    await sw.uncheck();
    await expect(navButton(dash, 'Suspicious')).toHaveCount(0);
    await expectNoAlertBadges();
    await expect.poll(() => actionTitle()).toBe('Tablight');
    await sw.check();
    await expect(navButton(dash, 'Suspicious')).toHaveText(/^Suspicious\s*1$/);
    await expectAlertBadges();
    await expect.poll(() => actionTitle()).toBe('Tablight: 1 suspicious tab');
  });
  await cleanSlate(); // a clean slate, as when this part was its own test
  await test.step('side panel: “Suspicious (N)” lists the same rows; Keep (icon) hides a row there and on the dashboard; Close all works there', async () => {
    await openSpam([SPAM, SPAM2]);
    // The panel page, opened as a tab (headless Chromium has no visible side panel).
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await test.step('the same rows with their reasons', async () => {
      const section = panel.getByRole('region', { name: 'Suspicious (2)' });
      await expect(section).toBeVisible();
      const rows = section.getByRole('list', { name: 'Suspicious tabs' }).getByRole('listitem');
      await expect(rows).toHaveCount(2);
      for (const title of [SUS_TITLES.spam, SUS_TITLES.spam2]) {
        await expect(rows.filter({ hasText: title }).locator('.item-note'))
          .toHaveText(reasonText('opener', 'unseen', 'address', 'title'));
      }
    });
    await test.step('Keep is an icon button and hides the row in the panel and on the dashboard', async () => {
      const keep = panel.getByRole('region', { name: 'Suspicious (2)' }).getByRole('button', { name: `Keep ${SUS_TITLES.spam}` });
      await expect(keep).toHaveClass('icon-btn'); // icon only in the narrow panel (worded on the dashboard)
      await expect(keep).toHaveText('');
      await keep.click();
      await expect(panel.getByRole('region', { name: 'Suspicious (1)' })).toBeVisible();
      const rows = panel.getByRole('list', { name: 'Suspicious tabs' }).getByRole('listitem');
      await expect(rows).toHaveCount(1);
      await expect(rows).toContainText(SUS_TITLES.spam2);
      await showSuspicious();
      await expect(susRow(dash, SUS_TITLES.spam)).toHaveCount(0);
      await expect(susRow(dash, SUS_TITLES.spam2)).toHaveCount(1);
      expect(await tabFor(SPAM)).toBeDefined(); // kept, not closed
      await expectAlertBadges(); // the other one is still flagged
    });
    await test.step('Close all in the panel closes the rest', async () => {
      await panel.bringToFront();
      const section = panel.getByRole('region', { name: 'Suspicious (1)' });
      await section.getByRole('button', { name: 'Close all (1)' }).click();
      const confirm = section.getByRole('group', { name: 'Close 1 suspicious tab?' });
      await expect(confirm.getByRole('listitem')).toHaveText([SUS_TITLES.spam2]);
      await confirm.getByRole('button', { name: 'Close tabs' }).click();
      await expect.poll(async () => (await tabs()).filter((t) => t.url === SPAM2).length).toBe(0);
      expect(await tabFor(SPAM)).toBeDefined();
      await expect(panel.getByRole('region', { name: /^Suspicious/ })).toHaveCount(0);
      await expectNoAlertBadges();
    });
  });
  await cleanSlate(); // a clean slate, as when this part was its own test
  await test.step('a duplicate pair plus a spam tab shows “!”; closing the spam tab brings “2×” back', async () => {
    const dup = server.url(PAGES[0]!.slug);
    await dash.evaluate((u) => Promise.all([0, 1].map(() => chrome.tabs.create({ url: u, active: false }))).then(() => undefined), dup);
    await waitIndexed([dup]);
    await expect.poll(async () => (await tabs()).filter((t) => t.url === dup).map((t) => t.text)).toEqual(['2×', '2×']);
    await openSpam();
    await expectAlertBadges(); // suspicious wins over the copy count
    await showSuspicious();
    await susRow(dash, SUS_TITLES.spam).getByRole('button', { name: `Close ${SUS_TITLES.spam}` }).click();
    await expect.poll(async () => (await tabFor(SPAM)) === undefined).toBe(true);
    await expect.poll(async () => (await tabs()).filter((t) => t.url === dup).map((t) => t.text)).toEqual(['2×', '2×']);
    await expectNoAlertBadges();
    expect((await tabs()).filter((t) => t.url !== dup).every((t) => t.text === '')).toBe(true);
  });
});

// ── other surfaces ──────────────────────────────────────────────────────────────────────────────────────

