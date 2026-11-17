/**
 * Popup, side panel and toolbar badge, end to end, in the BUILT extension (dist/). Run `npm run build` first.
 * Headless Chromium has no toolbar to click, so the popup and side panel pages are opened as tabs (or, where the
 * window they belong to matters, as their own window); "Side panel" itself is checked through the browser's list of
 * open extension contexts. IDs (P-…, SP-…, B-…) are rows of docs/testing/ui-test-cases.md.
 */
import { expect, test, type Page } from '@playwright/test';
import { escapeRe, navButton } from './fixtures/launch';
import { PAGES } from './fixtures/server';
import { FAULTS_SCRIPT, Harness, backup } from './fixtures/ui';

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

const P = (n: number) => PAGES[n]!;
const urlOf = (n: number) => h.url(P(n).slug);
const serverUrls = async () => (await h.tabs()).map((t) => t.url).filter((u) => u.startsWith(h.server.origin)).sort();
const activeIn = (windowId: number) => h.dash.evaluate((w) => chrome.tabs.query({ active: true, windowId: w }).then(([t]) => t?.url), windowId);
const dashWindow = () => h.dash.evaluate(() => chrome.windows.getCurrent().then((w) => w.id!));
/** Opens an extension page in its own window (not a tab of the test's windows) and returns it. */
async function inWindow(path: string, opts: { type?: 'normal' | 'popup'; focused?: boolean } = {}): Promise<Page> {
  const [p] = await Promise.all([
    h.context.waitForEvent('page', (x) => x.url().startsWith(h.ext(path))),
    h.dash.evaluate(({ url, type, focused }) => chrome.windows.create({ url, type, focused }), { url: h.ext(path), type: opts.type ?? 'popup', focused: opts.focused ?? false }),
  ]);
  await p.waitForLoadState();
  return p;
}
const sidePanels = () => h.sw.evaluate(() =>
  chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL' as chrome.runtime.ContextType] }).then((c) => c.length));

// ── popup ───────────────────────────────────────────────────────────────────────────────────────────────

test('P-01..P-02 popup: totals line, top groups; a group tile opens that group in the existing dashboard tab', async () => {
  const u = urlOf(0);
  await h.open([u, u, urlOf(10), urlOf(15)]);
  await h.dash.evaluate(async (url) => {
    const [t] = await chrome.tabs.query({ url });
    await chrome.tabs.discard(t!.id!);
  }, urlOf(15));
  await expect.poll(async () => (await h.state()).sleeping).toBe(1);
  const popup = await h.openPage('popup.html');
  await expect(popup.locator('.totals')).toHaveText('4 tabs · 1 window · 1 paused · 1 duplicate');
  const s = await h.state();
  const groupOf0 = s.groups.find((g) => g.id === s.items.find((i) => i.url === u)!.groupId)!;
  const tiles = popup.getByRole('list', { name: 'Top groups' }).getByRole('listitem');
  await expect(tiles).toHaveCount(new Set(s.items.map((i) => i.groupId).filter((g) => g !== null)).size);
  await tiles.filter({ hasText: groupOf0.name }).getByRole('button').click();
  // The popup closes and the one dashboard tab shows the group.
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect(h.dash.getByRole('heading', { level: 1 })).toHaveText(groupOf0.name);
  expect(h.dash.url()).toBe(h.dashUrl(`group=${encodeURIComponent(groupOf0.id)}`));
  expect((await h.tabs()).filter((t) => t.url.startsWith(h.ext('dashboard.html')))).toHaveLength(1);
});

test('P-03 popup with nothing grouped yet says so', async () => {
  const popup = await h.openPage('popup.html');
  await expect(popup.locator('.totals')).toHaveText('0 tabs · 0 windows · 0 paused · 0 duplicates');
  await expect(popup.getByText('Your groups appear here once tabs are sorted.')).toBeVisible();
});

test('P-04..P-06 popup search: words and a saved tab; Enter opens the first result; Esc clears; “No matches”', async () => {
  await h.open([urlOf(0), urlOf(15)]);
  await h.importBackup(backup({ items: [{ url: urlOf(44), title: P(44).title }] }));
  await expect(h.dash.locator('.toast')).toContainText('Imported 1 tab');
  let popup = await h.openPage('popup.html');
  const box = popup.getByRole('searchbox', { name: 'Search tabs' });
  await expect(box).toBeFocused(); // the popup opens ready to type
  await box.fill('kyoto');
  await expect(popup.getByRole('list', { name: 'Matches' }).getByRole('listitem').filter({ hasText: P(15).title })).toHaveCount(1);
  await box.press('Escape');
  await expect(box).toHaveValue('');
  await expect(popup.getByRole('list', { name: 'Top groups' })).toBeVisible();
  await box.fill('qqzzxxv');
  await expect(popup.getByText('No matches')).toBeVisible();
  // Enter on a match switches to that tab and closes the popup.
  await box.fill('kyoto');
  await expect(popup.getByRole('list', { name: 'Matches' }).getByRole('listitem')).toHaveCount(1);
  await box.press('Enter');
  await expect.poll(() => popup.isClosed()).toBe(true);
  await expect.poll(async () => (await h.tabsAt(urlOf(15)))[0]?.active).toBe(true);
  // A saved tab: clicking it opens it again.
  popup = await h.openPage('popup.html');
  await popup.getByRole('searchbox', { name: 'Search tabs' }).fill('sourdough');
  const hit = popup.getByRole('list', { name: 'Matches' }).getByRole('listitem').filter({ hasText: P(44).title });
  await expect(hit.locator('.state-stashed')).toHaveText('Saved');
  await hit.locator('.item-main').click();
  await expect.poll(async () => (await h.tabsAt(urlOf(44))).length).toBe(1);
});

test('P-07..P-08 popup: “This tab is open 2 times”: Switch goes to the other copy, “Close this one” closes this one', async () => {
  const u = urlOf(0);
  await h.open([u, u]);
  const [first, second] = await h.tabsAt(u);
  await h.dash.evaluate((id) => chrome.tabs.update(id, { active: true }).then(() => undefined), first!.id);
  // The popup is about the active tab of the last focused window: open it in its own, unfocused window.
  let popup = await inWindow('popup.html');
  const alert = popup.getByRole('region', { name: 'Duplicate tab' });
  await expect(alert).toContainText('This tab is open 2 times');
  await expect(alert).toContainText(P(0).title);
  await alert.getByRole('button', { name: 'Switch' }).click();
  await expect.poll(async () => (await h.tabs()).find((t) => t.id === second!.id)?.active).toBe(true);
  await expect.poll(() => popup.isClosed()).toBe(true);
  popup = await inWindow('popup.html');
  await popup.getByRole('region', { name: 'Duplicate tab' }).getByRole('button', { name: 'Close this one' }).click();
  await expect.poll(async () => (await h.tabsAt(u)).map((t) => t.id)).toEqual([first!.id]);
});

test('P-09 popup “Open dashboard” focuses the dashboard tab already open, or opens one', async () => {
  let popup = await h.openPage('popup.html');
  await popup.getByRole('button', { name: 'Open dashboard' }).click();
  await expect.poll(() => popup.isClosed()).toBe(true);
  const dashes = async () => (await h.tabs()).filter((t) => t.url.startsWith(h.ext('dashboard.html')));
  expect(await dashes()).toHaveLength(1);
  await expect.poll(async () => (await dashes())[0]!.active).toBe(true);
  await h.dash.close();
  popup = await h.openPage('popup.html');
  await popup.getByRole('button', { name: 'Open dashboard' }).click();
  h.dash = await h.pageWhere((u) => u === h.dashUrl());
  await expect(h.dash.getByRole('heading', { level: 1 })).toHaveText('All tabs');
});

test('P-10 popup “Side panel” opens the side panel and closes the popup', async () => {
  expect(await sidePanels()).toBe(0);
  const popup = await h.openPage('popup.html');
  await popup.getByRole('button', { name: 'Side panel' }).click();
  await expect.poll(sidePanels).toBe(1);
  await expect.poll(() => popup.isClosed()).toBe(true);
});

test('P-11..P-12 popup “Save window for later”: the window’s tabs are saved, the dashboard shows Undo there; an empty window says so', async () => {
  // A window with no web tab.
  let popup = await h.openPage('popup.html');
  await popup.getByRole('button', { name: 'Save window for later' }).click();
  await expect(popup.locator('.notice')).toHaveText('No web tabs to save in this window');
  await popup.close();
  // A second window with two pages, and a page left in the first window.
  const keep = urlOf(20);
  await h.open([keep]);
  const urls = [urlOf(0), urlOf(15)];
  const win = await h.openWindow(urls);
  const [pop] = await Promise.all([
    h.context.waitForEvent('page', (x) => x.url() === h.ext('popup.html')),
    h.dash.evaluate(({ url, win }) => chrome.tabs.create({ url, windowId: win, active: true }), { url: h.ext('popup.html'), win }),
  ]);
  popup = pop;
  await popup.getByRole('button', { name: 'Save window for later' }).click();
  await expect.poll(serverUrls).toEqual([keep]);
  // The dashboard (the one already open, in the other window) shows Saved for later with an Undo.
  const dash = await h.pageWhere((u) => u.startsWith(h.ext('dashboard.html#view=stashed')));
  await expect(dash.getByRole('heading', { level: 1 })).toHaveText('Saved for later');
  const toast = dash.locator('.toast');
  await expect(toast).toContainText('Saved 2 tabs for later');
  await expect(dash.getByRole('list', { name: 'Saved for later' }).getByRole('listitem')).toHaveCount(2);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(serverUrls).toEqual([keep, ...urls].sort());
  // The window was never closed.
  expect(await h.dash.evaluate((w) => chrome.windows.get(w).then((x) => x.id), win)).toBe(win);
});

test('P-13 popup “Pause other tabs”: pauses every other web tab, then says there is nothing left to pause', async () => {
  await h.open([urlOf(0), urlOf(15), urlOf(30)]);
  let popup = await h.openPage('popup.html');
  await popup.getByRole('button', { name: 'Pause other tabs' }).click();
  await expect(popup.locator('.notice')).toContainText('Paused 3 tabs');
  await expect.poll(async () => (await h.state()).sleeping).toBe(3);
  await expect(popup.locator('.totals')).toContainText('3 paused');
  await popup.close();
  popup = await h.openPage('popup.html');
  await popup.getByRole('button', { name: 'Pause other tabs' }).click();
  await expect(popup.locator('.notice')).toHaveText('Nothing to pause right now');
});

// ── error and loading states, popup and side panel alike ────────────────────────────────────────────────

for (const path of ['popup.html', 'sidepanel.html']) {
  test(`P-14 ${path}: “Couldn’t load your tabs” with Retry; the “Organizing” pill while the model works`, async () => {
    await h.open([urlOf(0)]);
    const p = await h.openPage(path, (pg) => pg.addInitScript(`${FAULTS_SCRIPT}; window.__failState = true;`));
    const alert = p.getByRole('alert');
    await expect(alert).toContainText('Couldn’t load your tabs.');
    await p.evaluate(() => { (window as unknown as { __failState: boolean }).__failState = false; });
    await alert.getByRole('button', { name: 'Retry' }).click();
    await expect(alert).toHaveCount(0);
    await expect(p.locator('.totals')).toContainText('1 tab');
    await expect(p.locator('.status-pill')).toHaveCount(0);
    await p.evaluate(() => { (window as unknown as { __notReady: boolean }).__notReady = true; });
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(p.locator('.status-pill')).toHaveText('Organizing');
  });
}

// ── side panel ──────────────────────────────────────────────────────────────────────────────────────────

/** The side panel page, as a tab of the dashboard's window (headless Chromium shows no real side panel). */
const panel = () => h.openPage('sidepanel.html');

test('SP-01..SP-03 side panel: This window open, groups folded; opening a group is remembered; other windows’ tabs stay out', async () => {
  await h.open([urlOf(0), urlOf(15)]);
  await h.openWindow([urlOf(30)]);
  const s = await h.state();
  const g0 = s.groups.find((g) => g.id === s.items.find((i) => i.url === urlOf(0))!.groupId)!;
  const p = await panel();
  const win = p.getByRole('region', { name: /^This window/ });
  await expect(win.getByRole('listitem')).toHaveCount(2);
  await expect(win).not.toContainText(P(30).title);
  const head = p.getByRole('button', { name: new RegExp(`^${escapeRe(g0.name)}`) });
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  await head.click();
  await expect(head).toHaveAttribute('aria-expanded', 'true');
  await expect(p.getByRole('region', { name: new RegExp(`^${escapeRe(g0.name)}`) })).toContainText(P(0).title);
  // Folding This window and unfolding the group are remembered.
  await p.getByRole('button', { name: /^This window/ }).click();
  await p.reload();
  await expect(p.getByRole('button', { name: /^This window/ })).toHaveAttribute('aria-expanded', 'false');
  await expect(p.getByRole('button', { name: new RegExp(`^${escapeRe(g0.name)}`) })).toHaveAttribute('aria-expanded', 'true');
});

test('SP-04..SP-07 side panel rows: the active tab is marked and has no Pause; Pause, Save for later (Undo), Close (Undo)', async () => {
  await h.open([urlOf(0), urlOf(15), urlOf(30)]);
  const p = await panel();
  // Make a page the window's active tab (the panel keeps running in the background).
  const active = (await h.tabsAt(urlOf(30)))[0]!;
  await h.dash.evaluate((id) => chrome.tabs.update(id, { active: true }).then(() => undefined), active.id);
  const win = p.getByRole('region', { name: /^This window/ });
  const row = (n: number) => win.getByRole('listitem').filter({ hasText: P(n).title });
  /** A row's buttons take clicks once the pointer is on the row, as for a user. */
  const press = async (n: number, name: string) => {
    await row(n).hover();
    await row(n).getByRole('button', { name }).click();
  };
  await expect(row(30)).toHaveAttribute('aria-current', 'page');
  await expect(row(30).getByRole('button', { name: 'Pause' })).toHaveCount(0);
  // Back to the panel (a hidden tab doesn't paint, so its buttons can't be clicked): now the panel is the active tab.
  await p.bringToFront();
  await expect(row(30)).not.toHaveAttribute('aria-current', 'page');
  await press(0, 'Pause');
  await expect(p.locator('.notice')).toContainText('Paused 1 tab');
  await expect(row(0).locator('.state-sleeping')).toHaveText('Paused');
  await press(15, 'Save for later');
  await expect(p.locator('.notice')).toContainText('Saved 1 tab for later');
  await expect.poll(() => h.tabsAt(urlOf(15))).toHaveLength(0);
  await p.locator('.notice').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await h.tabsAt(urlOf(15))).length).toBe(1);
  await expect(p.locator('.notice')).toHaveText('Undone');
  await press(0, 'Close');
  await expect(p.locator('.notice')).toContainText('Closed 1 tab');
  await expect.poll(() => h.tabsAt(urlOf(0))).toHaveLength(0);
  await p.locator('.notice').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await h.tabsAt(urlOf(0))).length).toBe(1);
});

test('SP-08..SP-10 side panel: search and Enter, Pause other tabs, Dashboard button, Unsorted section', async () => {
  await h.open([urlOf(0), urlOf(15), h.url('recipe-sourdough-bread')]);
  const p = await panel();
  const box = p.getByRole('searchbox', { name: 'Search tabs' });
  await box.fill('kyoto');
  await expect(p.getByRole('list', { name: 'Matches' }).getByRole('listitem')).toHaveCount(1);
  await box.press('Enter');
  await expect.poll(async () => (await h.tabsAt(urlOf(15)))[0]?.active).toBe(true);
  expect(p.isClosed()).toBe(false); // the panel stays open
  await box.press('Escape');
  await expect(box).toHaveValue('');
  if ((await h.item(h.url('recipe-sourdough-bread'))).groupId === null) {
    await expect(p.getByRole('button', { name: /^Unsorted/ })).toBeVisible();
  }
  await p.getByRole('button', { name: 'Pause other tabs' }).click();
  await expect(p.locator('.notice')).toContainText('Paused 2 tabs'); // not the active one
  await p.getByRole('button', { name: 'Dashboard' }).click();
  await expect.poll(async () => (await h.tabs()).find((t) => t.url.startsWith(h.ext('dashboard.html')))?.active).toBe(true);
});

test('SP-11 side panel: a group of more than 300 tabs shows 300 and links to the dashboard for the rest', async () => {
  const items = Array.from({ length: 301 }, (_, n) => ({ url: h.url(P(n % PAGES.length).slug, `n=${n}`), title: `Bulk page ${n}`, group: 'Bulk' }));
  await h.importBackup(backup({ items, groups: ['Bulk'] }));
  await expect(h.dash.locator('.toast')).toContainText('Imported 301 tabs');
  const p = await panel();
  await p.getByRole('button', { name: /^Bulk/ }).click();
  const region = p.getByRole('region', { name: /^Bulk/ });
  await expect(region.getByRole('listitem')).toHaveCount(300);
  await region.getByRole('button', { name: 'Show all 301 in the dashboard' }).click();
  await expect.poll(async () => (await h.tabs()).find((t) => t.url.startsWith(h.ext('dashboard.html')))?.active).toBe(true);
});

test('SP-12 side panel: more than 3 suspicious tabs show 3 and “Show all (N)”', async () => {
  const A = `http://localhost:${h.server.port}`;
  const targets = [2, 3, 4, 5].map((v) => `${h.server.origin}/click?key=1&visitor_id=2&v=${v}`);
  const opener = await h.context.newPage();
  await opener.goto(`${A}/opener?${targets.map((t) => `to=${encodeURIComponent(t)}`).join('&')}`);
  for (let n = 0; n < targets.length; n++) await opener.locator(`#open${n}`).click({ modifiers: ['ControlOrMeta'] });
  await expect.poll(async () => (await h.state()).suspicious.length, { timeout: 60_000 }).toBe(4);
  const p = await panel();
  const sus = p.getByRole('region', { name: 'Suspicious (4)' });
  const rows = sus.getByRole('list', { name: 'Suspicious tabs' }).getByRole('listitem');
  await expect(rows).toHaveCount(3);
  await sus.getByRole('button', { name: 'Show all (4)' }).click();
  await expect(rows).toHaveCount(4);
  await sus.getByRole('button', { name: 'Show fewer' }).click();
  await expect(rows).toHaveCount(3);
  // Folding the section hides the rows.
  await p.getByRole('button', { name: 'Suspicious (4)' }).click();
  await expect(rows).toHaveCount(0);
  await expect(p.getByRole('button', { name: 'Suspicious (4)' })).toHaveAttribute('aria-expanded', 'false');
});

// ── toolbar badge ───────────────────────────────────────────────────────────────────────────────────────

test('B-01 toolbar badge: empty on a normal tab, “3×” on each of three copies, back to empty when the copies close', async () => {
  const u = urlOf(0);
  await h.open([urlOf(15), u, u, u]);
  const badges = async () => Object.fromEntries((await h.tabs()).filter((t) => t.url.startsWith(h.server.origin)).map((t) => [`${t.url}#${t.id}`, t.badge]));
  await expect.poll(async () => (await h.tabsAt(u)).map((t) => t.badge)).toEqual(['3×', '3×', '3×']);
  await expect.poll(async () => (await h.tabsAt(urlOf(15)))[0]?.badge).toBe('');
  expect(await h.dash.evaluate(() => chrome.action.getTitle({}))).toBe('Tablight');
  await navButton(h.dash, 'Duplicates').click();
  await h.dash.getByRole('button', { name: 'Close duplicates' }).click();
  await h.dash.getByRole('dialog', { name: 'Close 2 duplicate tabs?' }).getByRole('button', { name: 'Close duplicates' }).click();
  await expect.poll(async () => (await h.tabsAt(u)).map((t) => t.badge)).toEqual(['']);
  expect(Object.values(await badges()).every((b) => b === '')).toBe(true);
});

test('B-02 the side panel is off on an empty new tab and on for a page; the icon opens the popup by default', async () => {
  await h.open([urlOf(0)]);
  const blank = await h.dash.evaluate(() => chrome.tabs.create({ url: 'about:blank', active: false }).then((t) => t.id!));
  await expect.poll(() => h.dash.evaluate((id) => chrome.sidePanel.getOptions({ tabId: id }).then((o) => o.enabled), blank)).toBe(false);
  const page0 = (await h.tabsAt(urlOf(0)))[0]!.id;
  await expect.poll(() => h.dash.evaluate((id) => chrome.sidePanel.getOptions({ tabId: id }).then((o) => o.enabled !== false), page0)).toBe(true);
  expect(await h.dash.evaluate(() => chrome.action.getPopup({}))).toBe(h.ext('popup.html'));
  expect(await activeIn(await dashWindow())).toBe(h.dashUrl());
});
