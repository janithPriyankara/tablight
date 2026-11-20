/**
 * The opt-in look-up, end to end, in the BUILT extension (dist/). Run `npm run build` first.
 * Nothing reaches the network: the Wikidata search API is routed to a fixture, the Google results page the tab shows
 * to a local stub, and a catch-all route aborts (and fails the test on) anything else. Requests are also watched from
 * the service worker and, over raw CDP, the offscreen document. Checks that showing the button sends nothing, that "Look it up" → "Look up" sends
 * exactly one request (to the search API, with the text shown in the box, no Cookie, no Referer), and that
 * "Move to" puts the tab in that group. The zero-network run in extension.spec.ts stays as it is.
 */
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureNetwork, type NetworkCapture } from './fixtures/cdp-network';
import { navButton } from './fixtures/launch';
import type { Item } from '../../src/shared/types';
import { Harness, SETTLE_MS } from './fixtures/ui';

const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures', 'wikidata-search.json'), 'utf8');
const QUERY = 'zorblax quintet';
const GOOGLE = `https://www.google.com/search?q=${QUERY.replace(/ /g, '+')}`;
const GOOGLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>${QUERY} - Google Search</title>` +
  '<link rel="icon" href="data:,"></head><body><p>Results</p></body></html>';

let h: Harness;
let cdp: NetworkCapture;
const API = 'https://www.wikidata.org/w/api.php';
/** Every request to the Wikidata API that the fixture route served, with its headers. */
const seen: { url: string; headers: Record<string, string> }[] = [];
/** Requests the catch-all route aborted: anything but the extension, the Google stub and the Wikidata fixture. */
const unexpected: string[] = [];
/** Every request Playwright reported (pages and the service worker), as "source url". */
const traffic: { source: string; url: string }[] = [];
const allowed = (url: string): boolean =>
  url.startsWith(`chrome-extension://${h.extId}/`) || /^(data|blob):/.test(url) ||
  url.startsWith('https://www.google.com/') || url.startsWith(`${API}?`);
/** Every request seen anywhere: Playwright pages, the service worker, and (raw CDP) the offscreen document. */
const everything = () => [...traffic, ...cdp.requests.map((r) => ({ source: `cdp ${r.targetType}`, url: r.url }))];
const wikidataRequests = () => everything().filter((r) => /wikidata\.org/i.test(r.url));
test.use({ actionTimeout: 20_000 });
test.beforeAll(async () => {
  h = await Harness.start(['--remote-debugging-port=0']);
  cdp = await captureNetwork(h.dir);
  // Playwright tries the last-registered route first: this catch-all only gets what the two below do not take.
  await h.context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(`chrome-extension://${h.extId}/`)) return route.continue();
    unexpected.push(url);
    return route.abort();
  });
  await h.context.route('https://www.google.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: GOOGLE_HTML }));
  await h.context.route(`${API}?**`, async (route) => {
    const req = route.request();
    seen.push({ url: req.url(), headers: await req.allHeaders() });
    await route.fulfill({
      status: 200, contentType: 'application/json; charset=utf-8', body: FIXTURE,
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  h.context.on('request', (r: Request) => traffic.push({ source: r.serviceWorker() ? 'service-worker' : 'page', url: r.url() }));
  // A cookie the browser would send to Wikidata if the request carried credentials.
  await h.context.addCookies([{ name: 'probe', value: 'must-not-be-sent', domain: '.wikidata.org', path: '/', secure: true, sameSite: 'None' }]);
});
test.afterEach(() => {
  // Nothing may leave for anywhere else, from any page, the service worker or the offscreen document.
  expect(unexpected, 'requests the catch-all route aborted').toEqual([]);
  expect(everything().filter((r) => !allowed(r.url)), 'requests to anything but the extension, the stub and the fixture').toEqual([]);
});
test.afterAll(async () => {
  cdp?.close();
  await h?.close();
});
const lookupButtons = (p: Page | Locator) => p.getByRole('button', { name: 'Look it up' });
/**
 * Opens the Google results tab (as a Playwright page, so the route serves it: a tab made by chrome.tabs.create can
 * start loading before routing is attached and reach the real site) and waits until it is indexed and classified.
 */
async function openGoogle(): Promise<Item> {
  const tab = await h.context.newPage();
  await tab.goto(GOOGLE);
  await expect(tab.locator('body')).toHaveText('Results'); // the local stub, never the real site
  await h.dash.bringToFront();
  let found: Item | undefined;
  await expect.poll(async () => {
    const s = await h.state();
    found = s.items.find((i) => i.url === GOOGLE && i.tabId !== undefined && i.title === `${QUERY} - Google Search` &&
      i.embKey !== undefined);
    return found !== undefined && s.queued === 0;
  }, { timeout: SETTLE_MS }).toBe(true);
  return found!;
}
const itemById = async (id: string) => (await h.state()).items.find((i) => i.id === id);

test('Look it up: nothing is sent until "Look up"; then one request with the shown text; "Move to" moves the tab', async () => {
  await h.reset();
  const it = await openGoogle();
  // The guards work: the stub page was seen, and a probe to anywhere else is aborted and recorded.
  expect(traffic.some((r) => r.url === GOOGLE)).toBe(true);
  const stub = h.context.pages().find((p) => p.url() === GOOGLE)!;
  expect(await stub.evaluate(() => fetch('https://probe.example.net/x').then(() => 'reached', () => 'blocked'))).toBe('blocked');
  expect(unexpected).toEqual(['https://probe.example.net/x']);
  unexpected.length = 0;
  traffic.splice(0, traffic.length, ...traffic.filter((r) => !r.url.startsWith('https://probe.example.net/')));
  // The fixture query is not a name anything knows: the tab stays Unsorted.
  expect(it.groupId).toBeNull();
  expect((await h.state()).groups.some((g) => g.id === 'tv')).toBe(true);

  await test.step('showing the button sends nothing (dashboard and side panel)', async () => {
    await navButton(h.dash, 'Unsorted').click();
    await expect(h.dash.getByRole('heading', { level: 1 })).toHaveText('Unsorted');
    const row = h.dash.getByRole('listitem').filter({ hasText: `${QUERY} - Google Search` });
    await expect(lookupButtons(row)).toHaveCount(1);
    const panel = await h.openPage('sidepanel.html');
    await expect(lookupButtons(panel.getByRole('listitem').filter({ hasText: `${QUERY} - Google Search` }))).toHaveCount(1);
    await panel.waitForTimeout(1500);
    await panel.close();
    expect(seen).toEqual([]);
    expect(wikidataRequests()).toEqual([]);
  });

  await test.step('Look it up → Look up: exactly one request, to the search API, with the shown text, no Cookie, no Referer', async () => {
    const row = h.dash.getByRole('listitem').filter({ hasText: `${QUERY} - Google Search` });
    await lookupButtons(row).click();
    const dialog = h.dash.getByRole('dialog', { name: 'Look it up' });
    await expect(dialog).toContainText('Tablight will send this text to Wikidata (Wikimedia Foundation) and nothing else:');
    await expect(dialog).toContainText('Never sent: the page address, your other tabs, cookies, or any ID.');
    const box = dialog.getByRole('textbox');
    await expect(box).toBeFocused();
    const shown = await box.inputValue();
    expect(shown.length).toBeGreaterThan(0);
    // The dialog is open and still nothing went out.
    expect(seen).toEqual([]);
    await dialog.getByRole('button', { name: 'Look up' }).click();
    await expect(dialog.getByRole('button', { name: 'Move to TV Series' })).toBeVisible();
    // Labels are text, never markup.
    await expect(dialog.getByRole('list', { name: 'Matches' })).toContainText('<b>Zorblax</b>');
    await h.dash.screenshot({ path: test.info().outputPath('lookup-dialog.png') });
    expect(seen).toHaveLength(1);
    // One request across every page, the service worker and the offscreen document.
    expect(wikidataRequests()).toHaveLength(1);
    expect(wikidataRequests()[0]!.source).toBe('page');
    const url = new URL(seen[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://www.wikidata.org/w/api.php');
    expect(url.searchParams.get('search')).toBe(shown);
    expect(url.searchParams.get('action')).toBe('wbsearchentities');
    const names = Object.keys(seen[0]!.headers).map((k) => k.toLowerCase());
    expect(names).not.toContain('cookie');
    expect(names).not.toContain('referer');
  });

  await test.step('"Move to TV Series" puts the tab in the group and closes the dialog', async () => {
    const dialog = h.dash.getByRole('dialog', { name: 'Look it up' });
    await dialog.getByRole('button', { name: 'Move to TV Series' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await itemById(it.id))?.groupId).toBe('tv');
    // It was the user's move, so the group learned from it.
    expect((await itemById(it.id))?.groupSource).toBe('user');
    expect(seen).toHaveLength(1);
  });
});

test('with the setting off there is no button, and Cancel / Escape send nothing', async () => {
  seen.length = 0;
  traffic.length = 0;
  cdp.requests.length = 0;
  await h.reset();
  expect((await openGoogle()).groupId).toBeNull();
  await navButton(h.dash, 'Unsorted').click();
  const row = h.dash.getByRole('listitem').filter({ hasText: `${QUERY} - Google Search` });
  await lookupButtons(row).click();
  const dialog = h.dash.getByRole('dialog', { name: 'Look it up' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await lookupButtons(row).click();
  await expect(dialog.getByRole('textbox')).toBeFocused();
  await h.dash.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await navButton(h.dash, 'Settings').click();
  const toggle = h.dash.getByRole('checkbox', { name: 'Show the Look it up button' });
  await expect(toggle).toBeChecked();
  await expect(h.dash.getByText('Sends only the text you confirm, to Wikidata. Nothing is sent unless you click.')).toBeVisible();
  await toggle.click();
  await expect.poll(async () => (await h.state()).settings.lookupButton).toBe(false);
  await navButton(h.dash, 'Unsorted').click();
  await expect(h.dash.getByRole('listitem').filter({ hasText: `${QUERY} - Google Search` })).toHaveCount(1);
  await expect(lookupButtons(h.dash)).toHaveCount(0);
  const panel = await h.openPage('sidepanel.html');
  await expect(panel.getByRole('listitem').filter({ hasText: `${QUERY} - Google Search` })).toHaveCount(1);
  await expect(lookupButtons(panel)).toHaveCount(0);
  await panel.close();
  expect(seen).toEqual([]);
  expect(wikidataRequests()).toEqual([]);
});
