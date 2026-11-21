/**
 * The opt-in look-up, end to end, in the BUILT extension (dist/). Run `npm run build` first.
 * Nothing reaches the network: the Wikidata and Wikipedia search APIs are routed to fixtures, the Google results page
 * the tab shows to a local stub, and a catch-all route aborts (and fails the test on) anything else. Requests are also
 * watched from the service worker and, over raw CDP, the offscreen document. Checks that showing the button sends
 * nothing, that "Look it up" → "Look up" sends exactly one request when Wikidata has a topical hit (to its search API,
 * with the text shown in the box, no Cookie, no Referer), exactly two (Wikidata, then Wikipedia, same text) when
 * Wikidata finds nothing, and that "Move to" puts the tab in that group. The zero-network run in extension.spec.ts
 * stays as it is.
 */
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureNetwork, type NetworkCapture } from './fixtures/cdp-network';
import { navButton } from './fixtures/launch';
import type { Item } from '../../src/shared/types';
import { Harness, SETTLE_MS } from './fixtures/ui';

const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures', 'wikidata-search.json'), 'utf8');
const WP_FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures', 'wikipedia-search.json'), 'utf8');
/** Wikidata's real reply when it finds nothing. */
const NO_HITS = JSON.stringify({ searchinfo: { search: '' }, search: [], success: 1 });
const QUERY = 'zorblax quintet';
/** What the Wikidata route answers: the fixture, or NO_HITS for the test where Wikidata finds nothing. */
let wikidataBody = FIXTURE;
/** While set, the Wikidata route holds its answer until this resolves (a slow Wikidata). */
let wikidataHold: Promise<void> | null = null;
const googleUrl = (q: string) => `https://www.google.com/search?q=${q.replace(/ /g, '+')}`;
const GOOGLE = googleUrl(QUERY);
const googleHtml = (q: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${q} - Google Search</title>` +
  '<link rel="icon" href="data:,"></head><body><p>Results</p></body></html>';

let h: Harness;
let cdp: NetworkCapture;
const API = 'https://www.wikidata.org/w/api.php';
const WP_API = 'https://en.wikipedia.org/w/api.php';
/** Every request to the Wikidata API that the fixture route served, with its headers. */
const seen: { url: string; headers: Record<string, string> }[] = [];
/** Every request to the Wikipedia API that its fixture route served, with its headers. */
const wpSeen: { url: string; headers: Record<string, string> }[] = [];
/** Both APIs' requests in the order the routes saw them. */
const order: string[] = [];
/** Requests the catch-all route aborted: anything but the extension, the Google stub and the two fixtures. */
const unexpected: string[] = [];
/** Every request Playwright reported (pages and the service worker), as "source url". */
const traffic: { source: string; url: string }[] = [];
const allowed = (url: string): boolean =>
  url.startsWith(`chrome-extension://${h.extId}/`) || /^(data|blob):/.test(url) ||
  url.startsWith('https://www.google.com/') || url.startsWith(`${API}?`) || url.startsWith(`${WP_API}?`);
/** Every request seen anywhere: Playwright pages, the service worker, and (raw CDP) the offscreen document. */
const everything = () => [...traffic, ...cdp.requests.map((r) => ({ source: `cdp ${r.targetType}`, url: r.url }))];
const wikidataRequests = () => everything().filter((r) => /wikidata\.org/i.test(r.url));
const wikipediaRequests = () => everything().filter((r) => /wikipedia\.org/i.test(r.url));
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
  await h.context.route('https://www.google.com/**', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: googleHtml(q) });
  });
  await h.context.route(`${API}?**`, async (route) => {
    const req = route.request();
    seen.push({ url: req.url(), headers: await req.allHeaders() });
    order.push('wikidata');
    const body = wikidataBody;
    if (wikidataHold) await wikidataHold;
    // The page may have aborted the request meanwhile (the user cancelled): then there is nothing to answer.
    await route.fulfill({
      status: 200, contentType: 'application/json; charset=utf-8', body,
      headers: { 'access-control-allow-origin': '*' },
    }).catch(() => undefined);
  });
  await h.context.route(`${WP_API}?**`, async (route) => {
    const req = route.request();
    wpSeen.push({ url: req.url(), headers: await req.allHeaders() });
    order.push('wikipedia');
    await route.fulfill({
      status: 200, contentType: 'application/json; charset=utf-8', body: WP_FIXTURE,
      headers: { 'access-control-allow-origin': '*' },
    });
  });
  h.context.on('request', (r: Request) => traffic.push({ source: r.serviceWorker() ? 'service-worker' : 'page', url: r.url() }));
  // A cookie the browser would send to Wikidata if the request carried credentials.
  await h.context.addCookies([
    { name: 'probe', value: 'must-not-be-sent', domain: '.wikidata.org', path: '/', secure: true, sameSite: 'None' },
    { name: 'probe', value: 'must-not-be-sent', domain: '.wikipedia.org', path: '/', secure: true, sameSite: 'None' },
  ]);
});
test.afterEach(() => {
  wikidataBody = FIXTURE;
  wikidataHold = null;
  // Nothing may leave for anywhere else, from any page, the service worker or the offscreen document.
  expect(unexpected, 'requests the catch-all route aborted').toEqual([]);
  expect(everything().filter((r) => !allowed(r.url)), 'requests to anything but the extension, the stub and the fixtures').toEqual([]);
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
async function openGoogle(query = QUERY): Promise<Item> {
  const url = googleUrl(query);
  const tab = await h.context.newPage();
  await tab.goto(url);
  await expect(tab.locator('body')).toHaveText('Results'); // the local stub, never the real site
  await h.dash.bringToFront();
  let found: Item | undefined;
  await expect.poll(async () => {
    const s = await h.state();
    found = s.items.find((i) => i.url === url && i.tabId !== undefined && i.title === `${query} - Google Search` &&
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
    await expect(dialog).toContainText('Tablight will send this text to Wikimedia (Wikidata, and Wikipedia if Wikidata has no usable match) and nothing else:');
    await expect(dialog).toContainText('Never sent: the page address, your other tabs or cookies. Wikimedia sees your IP address, as any website does.');
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
    // Wikidata had a topical hit: Wikipedia was not asked.
    expect(wpSeen).toEqual([]);
    expect(wikipediaRequests()).toEqual([]);
    await expect(dialog.locator('.lookup-hit-source').first()).toHaveText('Wikidata');
  });

  await test.step('"Move to TV Series" puts the tab in the group and closes the dialog', async () => {
    const dialog = h.dash.getByRole('dialog', { name: 'Look it up' });
    await dialog.getByRole('button', { name: 'Move to TV Series' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await itemById(it.id))?.groupId).toBe('tv');
    // It was the user's move, so the group learned from it.
    expect((await itemById(it.id))?.groupSource).toBe('user');
    expect(seen).toHaveLength(1);
    expect(wpSeen).toEqual([]);
  });
});

test('Wikidata finds nothing: exactly two requests, Wikidata then Wikipedia, same text; "Move to" works', async () => {
  seen.length = 0;
  wpSeen.length = 0;
  order.length = 0;
  traffic.length = 0;
  cdp.requests.length = 0;
  await h.reset(); // also empties the look-up cache, so the same text is asked afresh
  wikidataBody = NO_HITS; // the same query, but this time Wikidata finds nothing (reset by afterEach)
  const it = await openGoogle();
  expect(it.groupId).toBeNull();
  await navButton(h.dash, 'Unsorted').click();
  const row = h.dash.getByRole('listitem').filter({ hasText: `${QUERY} - Google Search` });
  await lookupButtons(row).click();
  const dialog = h.dash.getByRole('dialog', { name: 'Look it up' });
  await expect(dialog).toContainText('Tablight will send this text to Wikimedia (Wikidata, and Wikipedia if Wikidata has no usable match) and nothing else:');
  const shown = await dialog.getByRole('textbox').inputValue();
  expect(shown.length).toBeGreaterThan(0);
  expect([...seen, ...wpSeen]).toEqual([]);
  await dialog.getByRole('button', { name: 'Look up' }).click();
  await expect(dialog.getByRole('button', { name: 'Move to TV Series' })).toBeVisible();
  const list = dialog.getByRole('list', { name: 'Matches' });
  // Wikipedia's search order (index), each hit tagged; titles are text, never markup, and snippets are not shown.
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').first()).toContainText('Zorblax Quintet');
  await expect(list.getByRole('listitem').nth(1)).toContainText('<i>Zorblax</i> (character)');
  await expect(list.locator('.lookup-hit-source')).toHaveText(['Wikipedia', 'Wikipedia']);
  await expect(list).not.toContainText('must not render');
  expect(await list.locator('i, span.searchmatch').count()).toBe(0);
  await h.dash.screenshot({ path: test.info().outputPath('lookup-dialog-wikipedia.png') });
  // Exactly two requests, Wikidata first, both from the page, both with the shown text, neither with Cookie or Referer.
  expect(order).toEqual(['wikidata', 'wikipedia']);
  expect(seen).toHaveLength(1);
  expect(wpSeen).toHaveLength(1);
  expect(wikidataRequests()).toHaveLength(1);
  expect(wikipediaRequests()).toHaveLength(1);
  expect([...wikidataRequests(), ...wikipediaRequests()].map((r) => r.source)).toEqual(['page', 'page']);
  const wd = new URL(seen[0]!.url);
  const wp = new URL(wpSeen[0]!.url);
  expect(`${wd.origin}${wd.pathname}`).toBe(API);
  expect(`${wp.origin}${wp.pathname}`).toBe(WP_API);
  expect(wd.searchParams.get('search')).toBe(shown);
  expect(wp.searchParams.get('gsrsearch')).toBe(shown);
  expect(wp.searchParams.get('action')).toBe('query');
  expect(wp.searchParams.get('generator')).toBe('search');
  expect(wp.searchParams.get('prop')).toBe('description');
  for (const r of [seen[0]!, wpSeen[0]!]) {
    const names = Object.keys(r.headers).map((k) => k.toLowerCase());
    expect(names).not.toContain('cookie');
    expect(names).not.toContain('referer');
  }
  await dialog.getByRole('button', { name: 'Move to TV Series' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await itemById(it.id))?.groupId).toBe('tv');
  expect((await itemById(it.id))?.groupSource).toBe('user');
  expect(seen).toHaveLength(1);
  expect(wpSeen).toHaveLength(1);
});

test('Cancel while a slow Wikidata (no hits) is still answering: no Wikipedia request is ever made', async () => {
  seen.length = 0;
  wpSeen.length = 0;
  order.length = 0;
  traffic.length = 0;
  cdp.requests.length = 0;
  await h.reset();
  wikidataBody = NO_HITS; // would trigger the fallback, had the user not cancelled (reset by afterEach)
  let release!: () => void;
  wikidataHold = new Promise<void>((res) => (release = res));
  expect((await openGoogle()).groupId).toBeNull();
  await navButton(h.dash, 'Unsorted').click();
  const row = h.dash.getByRole('listitem').filter({ hasText: `${QUERY} - Google Search` });
  await lookupButtons(row).click();
  const dialog = h.dash.getByRole('dialog', { name: 'Look it up' });
  await dialog.getByRole('button', { name: 'Look up' }).click();
  await expect(dialog.getByText('Looking up…')).toBeVisible();
  await expect.poll(() => seen.length).toBe(1); // Wikidata has the request and is holding its answer
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  release();
  // Give a fallback every chance to start: none may.
  await h.dash.waitForTimeout(2000);
  expect(order).toEqual(['wikidata']);
  expect(wpSeen).toEqual([]);
  expect(wikipediaRequests()).toEqual([]);
  expect(wikidataRequests()).toHaveLength(1);
});
test('with the setting off there is no button, and Cancel / Escape send nothing', async () => {
  seen.length = 0;
  wpSeen.length = 0;
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
  await expect(h.dash.getByText('Sends only the text you confirm, to Wikidata (and to Wikipedia if Wikidata has no usable match). Nothing is sent unless you click.')).toBeVisible();
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
  expect(wpSeen).toEqual([]);
  expect(wikidataRequests()).toEqual([]);
  expect(wikipediaRequests()).toEqual([]);
});
