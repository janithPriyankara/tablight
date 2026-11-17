/**
 * End-to-end tests of the BUILT extension (dist/) in real Chromium. Run `npm run build` first.
 *
 * Every request the extension makes is recorded: its pages and service worker through Playwright's
 * context 'request' event, its offscreen document (which Playwright does not attach to) through a raw
 * DevTools connection (fixtures/cdp-network.ts). Only the extension itself and the local test server
 * may be contacted. Not covered: the first (navigation) request of tabs opened through chrome.windows /
 * chrome.tabs.create, which Playwright attaches to too late; those are the test pages themselves.
 */
import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DashboardState, Item } from '../../src/shared/types';
import { captureNetwork, type NetworkCapture } from './fixtures/cdp-network';
import { DIST, assertBuilt, escapeRe, launchExtension, navButton, rpc, state } from './fixtures/launch';
import { PAGES, startPageServer, type PageServer } from './fixtures/server';
import { MODEL_ID } from '../../scripts/model-manifest.mjs';

assertBuilt();
/** Generous: the first model load in a fresh profile, and 50+ tabs loading at once. */
const SETTLE_MS = 120_000;

interface Ext {
  context: BrowserContext;
  sw: Worker;
  id: string;
  dashboard: Page;
  cdp: NetworkCapture;
}

/** Every request seen, tagged with where it was captured. */
const requests: { source: 'page' | 'service-worker'; url: string }[] = [];
const cdpCaptures: NetworkCapture[] = [];
let server: PageServer;
const tempDirs: string[] = [];
/** Every context launched, so a failing test never leaves a Chromium behind. */
const contexts: BrowserContext[] = [];

test.beforeAll(async () => {
  server = await startPageServer();
});
test.afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => undefined);
  for (const c of cdpCaptures) c.close();
  await server.close();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'tab-organizer-e2e-'));
  tempDirs.push(d);
  return d;
}

/** Tabs of the local test server, read through the extension's own tabs API. */
function serverTabs(page: Page): Promise<chrome.tabs.Tab[]> {
  return page.evaluate((origin) => chrome.tabs.query({ url: `${origin}/*` }), server.origin);
}

/**
 * Launches Chromium with only dist/ loaded (headless, full Chromium build: the headless shell cannot
 * run extensions), records its network traffic, and opens the dashboard once the starter groups exist.
 */
async function launch(): Promise<Ext> {
  const dir = tempDir();
  // The request recorder is attached before the extension's worker is even looked up.
  const { context, sw, id } = await launchExtension(dir, ['--remote-debugging-port=0'], (c) => {
    contexts.push(c);
    c.on('request', (r) => requests.push({ source: r.serviceWorker() ? 'service-worker' : 'page', url: r.url() }));
  });
  try {
    const cdp = await captureNetwork(dir);
    cdpCaptures.push(cdp);
    const dashboard = await context.newPage();
    await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
    // Starter groups are built with the model on install; wait for them before going on.
    await expect.poll(async () => (await state(dashboard)).groups.length, { timeout: SETTLE_MS }).toBeGreaterThan(0);
    // An offscreen document created before the capture attached would be only partly recorded: close it,
    // so every later one is recorded from its first request.
    await sw.evaluate(() => chrome.offscreen.closeDocument().catch(() => undefined));
    return { context, sw, id, dashboard, cdp };
  } catch (e) {
    await context.close().catch(() => undefined); // never leave a half-launched Chromium behind
    throw e;
  }
}

/** Opens one window per list of URLs (from the extension page, so the window count is exact). */
async function openWindows(page: Page, windows: string[][]): Promise<void> {
  for (const urls of windows) {
    await page.evaluate((u) => chrome.windows.create({ url: u, focused: false }).then(() => undefined), urls);
  }
}

const onServer = (i: Item) => i.url.startsWith(server.origin);

/** Waits until every test tab is loaded, indexed under its real title, and classified (queue empty). */
async function waitSettled(page: Page, tabs: number): Promise<DashboardState> {
  await expect.poll(async () => {
    const t = await serverTabs(page);
    return t.length === tabs && t.every((x) => x.status === 'complete' && x.title && !x.title.startsWith('http'));
  }, { timeout: SETTLE_MS, intervals: [250] }).toBe(true);
  let last: DashboardState | undefined;
  await expect.poll(async () => {
    last = await state(page);
    const mine = last.items.filter((i) => onServer(i) && i.state !== 'stashed');
    return last.modelReady && last.queued === 0 && mine.length === tabs && mine.every((i) => i.embKey !== undefined && !i.title.startsWith('http'));
  }, { timeout: SETTLE_MS, intervals: [250] }).toBe(true);
  return last!;
}

function assertNoForeignRequests(id: string | undefined): void {
  const allowed = (url: string) =>
    (id !== undefined && url.startsWith(`chrome-extension://${id}/`)) ||
    url.startsWith(`${server.origin}/`) ||
    /^(data|blob|about|chrome):/.test(url);
  const all = [
    ...requests,
    ...cdpCaptures.flatMap((c) => c.requests.map((r) => ({ source: `cdp ${r.targetType}`, url: r.url }))),
  ];
  const count = (src: string) => all.filter((r) => r.source === src).length;
  console.log(`network: ${all.length} requests checked (Playwright: page ${count('page')}, service worker ` +
    `${count('service-worker')}; raw CDP: offscreen ${count('cdp other') + count('cdp background_page')})`);
  // The recorders are live: extension pages, the worker and the offscreen document all reached them.
  expect(all.some((r) => r.source === 'page' && r.url.endsWith('/dashboard.html'))).toBe(true);
  expect(all.some((r) => r.source === 'service-worker')).toBe(true);
  expect(all.some((r) => r.source.startsWith('cdp ') && r.url.endsWith('/offscreen.html'))).toBe(true);
  const bad = all.filter((r) => !allowed(r.url));
  expect(bad, `requests to anything but the extension and the test pages:\n${bad.map((r) => `${r.source}: ${r.url}`).join('\n')}`).toEqual([]);
}

test.describe.configure({ mode: 'serial' });

let extId: string | undefined;
/**
 * Static backstop for the offscreen document (whose traffic is also captured live below): the built
 * bundle pins the model and the ONNX WASM to the extension's own files before any pipeline is built.
 */
test('offscreen bundle points Transformers.js at bundled files before building the pipeline', () => {
  const file = readdirSync(join(DIST, 'assets')).find((f) => /^offscreen-.*\.js$/.test(f));
  expect(file, 'dist/assets/offscreen-*.js').toBeDefined();
  const js = readFileSync(join(DIST, 'assets', file!), 'utf8');
  const q = '[`\'"]';
  const at = (re: RegExp) => {
    const m = re.exec(js);
    expect(m, String(re)).not.toBeNull();
    return m!.index;
  };
  const config = [
    at(/allowRemoteModels\s*=\s*(?:!1|false)/),
    at(new RegExp(`localModelPath\\s*=\\s*chrome\\.runtime\\.getURL\\(${q}models/${q}\\)`)),
    at(/useBrowserCache\s*=\s*(?:!1|false)/),
    at(new RegExp(`wasmPaths\\s*=\\s*\\{\\s*mjs:\\s*chrome\\.runtime\\.getURL\\(${q}ort/ort-wasm-simd-threaded\\.mjs${q}\\)\\s*,\\s*wasm:\\s*chrome\\.runtime\\.getURL\\(${q}ort/ort-wasm-simd-threaded\\.wasm${q}\\)`)),
  ];
  // The remaining Global Constraints flags, anchored to the app's own assignment sequence (the library
  // has same-named defaults elsewhere): local models on, wasm cache off, one thread, no proxy worker.
  const sequence = (re: RegExp) => expect(js, String(re)).toMatch(re);
  sequence(/allowLocalModels\s*=\s*(?:!0|true)\s*[,;]\s*\w+\.localModelPath\s*=/);
  sequence(/useBrowserCache\s*=\s*(?:!1|false)\s*[,;]\s*\w+\.useWasmCache\s*=\s*(?:!1|false)\b/);
  sequence(/wasmPaths\s*=\s*\{[^}]*\}\s*[,;]\s*\w+\.numThreads\s*=\s*1\s*[,;]\s*\w+\.proxy\s*=\s*(?:!1|false)\b/);
  // The bundled model (src/classify/model.ts, pinned in scripts/model-manifest.mjs) is the one loaded: its id is
  // in the offscreen chunk or in a chunk it imports (the constant is shared with the background).
  const imported = [...js.matchAll(/from\s*["']\.\/([\w.-]+\.js)["']/g)].map((m) => readFileSync(join(DIST, 'assets', m[1]!), 'utf8'));
  expect([js, ...imported].some((c) => c.includes(MODEL_ID)), MODEL_ID).toBe(true);
  const pipelineCall = at(new RegExp(`${q}feature-extraction${q}\\s*,`));
  for (const i of config) expect(i).toBeLessThan(pipelineCall);
  for (const f of ['ort/ort-wasm-simd-threaded.mjs', 'ort/ort-wasm-simd-threaded.wasm', `models/${MODEL_ID}/onnx/model_quantized.onnx`]) {
    expect(existsSync(join(DIST, f)), f).toBe(true);
  }
});

test('flows: groups, duplicates, stash/open, sleep, search, export → import', async () => {
  const ext = await launch();
  extId = ext.id;
  const page = ext.dashboard;

  // ── 50 local pages across 3 windows, 3 of them duplicates ──
  const unique = PAGES.slice(0, 47).map((p) => server.url(p.slug));
  const dups = [server.url(PAGES[0]!.slug), server.url(PAGES[10]!.slug), server.url(PAGES[20]!.slug)];
  const all = [...unique, ...dups];
  // Copies land in a different window from their original.
  await openWindows(page, [[...all.slice(0, 16), all[49]!], all.slice(16, 33), [...all.slice(33, 47), all[47]!, all[48]!]]);
  const t0 = Date.now();
  let s = await waitSettled(page, 50);
  console.log(`50 tabs loaded and classified in ${Date.now() - t0} ms`);

  // ── groups ──
  const mine = s.items.filter(onServer);
  const perGroup = new Map<string, number>();
  for (const i of mine) if (i.groupId !== null) perGroup.set(i.groupId, (perGroup.get(i.groupId) ?? 0) + 1);
  const names = new Map(s.groups.map((g) => [g.id, g.name]));
  console.log('groups:', [...perGroup].map(([g, n]) => `${names.get(g)}=${n}`).join(', '),
    `· unsorted=${mine.filter((i) => i.groupId === null).length}`);
  expect(perGroup.size).toBeGreaterThanOrEqual(5);
  // The sidebar shows the same groups with their counts.
  for (const [g, n] of perGroup) await expect(navButton(page, names.get(g)!)).toContainText(String(n));

  // ── duplicates ──
  expect(s.dupCount).toBe(3);
  await expect(navButton(page, 'Duplicates')).toContainText('3');
  await page.getByRole('button', { name: 'Close duplicates' }).click();
  const confirmDialog = page.getByRole('dialog', { name: 'Close 3 duplicate tabs?' });
  await confirmDialog.getByRole('button', { name: 'Close duplicates' }).click();
  await expect.poll(async () => (await serverTabs(page)).length).toBe(47);
  await expect(page.getByRole('status').filter({ hasText: 'Closed 3 duplicate tabs' })).toBeVisible();
  await expect.poll(async () => (await state(page)).dupCount).toBe(0);
  expect(new Set((await serverTabs(page)).map((t) => t.url)).size).toBe(47);

  // ── stash a group: its tabs close, its items appear in Stashed ──
  s = await state(page);
  const openPerGroup = new Map<string, Item[]>();
  for (const i of s.items.filter((x) => onServer(x) && x.state === 'open' && x.groupId !== null)) {
    openPerGroup.set(i.groupId!, [...(openPerGroup.get(i.groupId!) ?? []), i]);
  }
  // A mid-sized group (2+ tabs, not the biggest) keeps plenty of tabs open for the later steps.
  const [stashGroupId, stashItems] = [...openPerGroup].filter(([, v]) => v.length >= 2).sort((a, b) => a[1].length - b[1].length)[0]!;
  const stashUrls = new Set(stashItems.map((i) => i.url));
  await navButton(page, names.get(stashGroupId)!).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(names.get(stashGroupId)!);
  await page.getByRole('button', { name: 'Save group for later' }).click();
  await expect.poll(async () => (await serverTabs(page)).length).toBe(47 - stashItems.length);
  expect((await serverTabs(page)).some((t) => stashUrls.has(t.url!))).toBe(false);
  await expect.poll(async () =>
    (await state(page)).items.filter((i) => i.state === 'stashed' && stashUrls.has(i.url)).length).toBe(stashItems.length);
  await navButton(page, 'Saved for later').click();
  const stashedList = page.getByRole('list', { name: 'Saved for later' });
  for (const i of stashItems) await expect(stashedList.getByRole('listitem').filter({ hasText: i.title })).toHaveCount(1);

  // ── open one stashed item: a tab appears and the item leaves the stash ──
  const reopen = stashItems[0]!;
  await stashedList.getByRole('listitem').filter({ hasText: reopen.title }).getByRole('button', { name: 'Open', exact: true }).click();
  await expect.poll(async () => (await serverTabs(page)).some((t) => t.url === reopen.url)).toBe(true);
  await expect(stashedList.getByRole('listitem').filter({ hasText: reopen.title })).toHaveCount(0);
  await expect.poll(async () =>
    (await state(page)).items.filter((i) => i.state === 'stashed' && stashUrls.has(i.url)).length).toBe(stashItems.length - 1);
  const stillStashed = stashItems.slice(1).map((i) => i.url).sort();

  // ── sleep a tab (an inactive one: active tabs are never slept) ──
  const candidates = (await serverTabs(page)).filter((t) => !t.active && !t.discarded && t.url !== reopen.url);
  const target = candidates[0]!;
  await page.getByRole('searchbox', { name: 'Search tabs' }).fill(target.title!);
  const results = page.getByRole('list', { name: `Results for “${target.title!}”` });
  await results.getByRole('listitem').filter({ hasText: target.title! }).first().getByRole('button', { name: 'Pause', exact: true }).click();
  // Discarding may replace the tab (and its id), so it is found again by URL.
  await expect.poll(async () => (await serverTabs(page)).filter((t) => t.url === target.url).map((t) => t.discarded)).toEqual([true]);
  await expect.poll(async () => (await state(page)).items.filter((i) => i.url === target.url).map((i) => i.state)).toEqual(['sleeping']);

  // ── search "agent" ──
  await page.getByRole('searchbox', { name: 'Search tabs' }).fill('agent');
  const agentResults = page.getByRole('list', { name: 'Results for “agent”' });
  await expect(agentResults.getByRole('listitem').first()).toBeVisible();
  expect(await agentResults.getByRole('listitem').count()).toBeGreaterThanOrEqual(1);
  await expect(agentResults.getByRole('listitem').filter({ hasText: /agent/i }).first()).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search tabs' }).fill('');

  // ── export ──
  await navButton(page, 'Settings').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export backup' }).click(),
  ]);
  const backup = join(tempDir(), download.suggestedFilename());
  await download.saveAs(backup);
  expect(download.suggestedFilename()).toMatch(/^tablight-\d{4}-\d{2}-\d{2}\.json$/);
  const exported = readFileSync(backup, 'utf8');
  for (const url of stillStashed) expect(exported).toContain(url);

  // Every offscreen document of this profile was recorded from its first request: prove the capture
  // actually saw the model load (else "no foreign request" would be vacuous for the offscreen side).
  const offscreenUrls = ext.cdp.requests.map((r) => r.url);
  expect(offscreenUrls.some((u) => u.endsWith('/offscreen.html'))).toBe(true);
  expect(offscreenUrls.some((u) => u.includes('/models/') && u.endsWith('.onnx'))).toBe(true);
  expect(offscreenUrls.some((u) => u.includes('/ort/') && u.endsWith('.wasm'))).toBe(true);
  // ...and that service-worker traffic reaches the recorder.
  await ext.sw.evaluate(() => fetch(chrome.runtime.getURL('manifest.json')).then((r) => r.status));
  await expect.poll(() => requests.some((r) => r.source === 'service-worker' && r.url.endsWith('/manifest.json'))).toBe(true);
  ext.cdp.close();
  await ext.context.close();

  // ── import into a fresh profile: the stash is restored ──
  const fresh = await launch();
  expect(fresh.id).toBe(ext.id); // same unpacked path, same id
  const p2 = fresh.dashboard;
  expect((await state(p2)).items.filter((i) => i.state === 'stashed')).toHaveLength(0);
  await navButton(p2, 'Settings').click();
  await p2.getByLabel('Import backup file').setInputFiles(backup);
  await expect(p2.getByRole('status').filter({ hasText: /^Imported/ })).toBeVisible();
  await expect.poll(async () =>
    (await state(p2)).items.filter((i) => i.state === 'stashed').map((i) => i.url).sort()).toEqual(stillStashed);
  await navButton(p2, 'Saved for later').click();
  const restored = p2.getByRole('list', { name: 'Saved for later' });
  for (const i of stashItems.slice(1)) await expect(restored.getByRole('listitem').filter({ hasText: i.title })).toHaveCount(1);
  fresh.cdp.close();
  await fresh.context.close();

  assertNoForeignRequests(extId);
});

test('clicking an entry switches to its tab, wakes a sleeping one, and drops one that was already closed', async () => {
  const ext = await launch();
  const page = ext.dashboard;
  const urls = PAGES.slice(0, 6).map((p) => server.url(p.slug));
  await openWindows(page, [urls.slice(0, 3), urls.slice(3, 6)]);
  let s = await waitSettled(page, 6);
  const itemFor = (u: string) => s.items.find((i) => i.url === u)!;
  const row = (title: string) => page.getByRole('button', { name: new RegExp(`^${escapeRe(title)}`) }).first();
  const activeIn = (windowId: number) =>
    page.evaluate((w) => chrome.tabs.query({ active: true, windowId: w }).then(([t]) => t?.id), windowId);
  await navButton(page, 'All tabs').click();
  // A tab in the other window that is not its window's active tab.
  const target = itemFor(urls[4]!);
  expect(await activeIn(target.windowId!)).not.toBe(target.tabId);
  await row(target.title).click();
  await expect.poll(() => activeIn(target.windowId!)).toBe(target.tabId);
  // A sleeping tab: the click switches to it and it loads again.
  const sleeper = itemFor(urls[1]!);
  await rpc(page, { t: 'sleep', ids: [sleeper.id] });
  await expect.poll(async () => (await state(page)).items.find((i) => i.url === urls[1])?.state).toBe('sleeping');
  s = await state(page);
  const slept = itemFor(urls[1]!);
  await row(slept.title).click();
  await expect.poll(() => activeIn(slept.windowId!)).toBe(slept.tabId);
  await expect.poll(() => page.evaluate((id) => chrome.tabs.get(id).then((t) => t.discarded), slept.tabId!)).toBe(false);
  // Closed a moment ago, before the list caught up: the click says so and the entry goes away.
  const gone = itemFor(urls[5]!);
  await page.evaluate((id) => chrome.tabs.remove(id), gone.tabId!);
  await row(gone.title).click();
  await expect(page.getByRole('status').filter({ hasText: 'That tab was already closed' })).toBeVisible();
  await expect(row(gone.title)).toHaveCount(0);
  await expect.poll(async () => (await state(page)).items.some((i) => i.url === urls[5])).toBe(false);
});
test('side panel: lists its window’s tabs, switches on click; the toolbar setting points the icon at it', async () => {
  const ext = await launch();
  const page = ext.dashboard;
  const urls = PAGES.slice(0, 4).map((p) => server.url(p.slug));
  await openWindows(page, [urls.slice(0, 2), urls.slice(2, 4)]);
  const s = await waitSettled(page, 4);
  const target = s.items.find((i) => i.url === urls[3])!;
  // The panel page, opened as a tab in the second window (headless Chromium has no visible side panel).
  const panel = await ext.context.newPage();
  await panel.goto(`chrome-extension://${ext.id}/sidepanel.html`);
  await panel.evaluate(async (w) => {
    const [me] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.move(me!.id!, { windowId: w, index: -1 });
  }, target.windowId!);
  await panel.reload();
  const section = panel.getByRole('region', { name: /This window/ });
  for (const u of [urls[2]!, urls[3]!]) {
    const title = s.items.find((i) => i.url === u)!.title;
    await expect(section.getByRole('button', { name: new RegExp(`^${escapeRe(title)}`) })).toBeVisible();
  }
  await expect(section.getByText(s.items.find((i) => i.url === urls[0])!.title)).toHaveCount(0);
  await section.getByRole('button', { name: new RegExp(`^${escapeRe(target.title)}`) }).click();
  await expect.poll(() => page.evaluate((w) => chrome.tabs.query({ active: true, windowId: w }).then(([t]) => t?.id), target.windowId!))
    .toBe(target.tabId);
  // The panel is off on an empty tab and on for a normal page. (about:blank, not chrome://newtab/: the browser's
  // own new-tab page loads Google's bar from the network, which the zero-network check would rightly flag.)
  const blankId = await page.evaluate(() => chrome.tabs.create({ url: 'about:blank', active: false }).then((t) => t.id!));
  await expect.poll(() => page.evaluate((id) => chrome.sidePanel.getOptions({ tabId: id }).then((o) => o.enabled), blankId)).toBe(false);
  await expect.poll(() => page.evaluate((id) => chrome.sidePanel.getOptions({ tabId: id }).then((o) => o.enabled !== false), target.tabId!)).toBe(true);
  await rpc(page, { t: 'settings', patch: { toolbarOpens: 'sidepanel' } });
  expect(await page.evaluate(() => chrome.action.getPopup({}))).toBe('');
  expect(await page.evaluate(() => chrome.sidePanel.getPanelBehavior())).toEqual({ openPanelOnActionClick: true });
  await rpc(page, { t: 'settings', patch: { toolbarOpens: 'popup' } });
  expect(await page.evaluate(() => chrome.action.getPopup({}))).toMatch(/popup\.html$/);
});
// @perf: opens 500 real tabs; CI runs it on its own so no other browser competes for memory.
test('performance: 500 tabs (20 windows × 25) are classified within 15 s of the last load', { tag: '@perf' }, async () => {
  test.slow();
  const ext = await launch();
  extId = ext.id;
  const page = ext.dashboard;
  // The model is already warm (it built the starter groups); its document was closed by launch(),
  // so the measured run also includes creating the offscreen document and loading the model again.
  const windows: string[][] = [];
  for (let w = 0; w < 20; w++) {
    windows.push(Array.from({ length: 25 }, (_, k) => {
      const n = w * 25 + k;
      return server.url(PAGES[n % PAGES.length]!.slug, `n=${n}`); // distinct pages, realistic titles
    }));
  }
  const t0 = Date.now();
  await openWindows(page, windows);
  await expect.poll(async () => {
    const t = await serverTabs(page);
    return t.length === 500 && t.every((x) => x.status === 'complete' && x.title && !x.title.startsWith('http'));
  }, { timeout: SETTLE_MS * 2, intervals: [250] }).toBe(true);
  const lastLoad = server.lastServedAt();
  let s: DashboardState | undefined;
  await expect.poll(async () => {
    s = await state(page);
    const mine = s.items.filter(onServer);
    return s.queued === 0 && mine.length === 500 && mine.every((i) => i.embKey !== undefined);
  }, { timeout: SETTLE_MS * 2, intervals: [250] }).toBe(true);
  const done = Date.now();
  const mine = s!.items.filter(onServer);
  const ms = done - lastLoad;
  console.log(`500 tabs: opened+loaded in ${lastLoad - t0} ms; last load → queue empty: ${ms} ms; ` +
    `grouped ${mine.filter((i) => i.groupId !== null).length}/500`);
  expect(ext.cdp.requests.some((r) => r.url.includes('/models/') && r.url.endsWith('.onnx'))).toBe(true);
  ext.cdp.close();
  await ext.context.close();
  assertNoForeignRequests(extId);
  expect(ms).toBeLessThan(15_000);
});
