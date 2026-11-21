/**
 * The Priority group, end to end in the BUILT extension (dist/). Run `npm run build` first.
 *
 * A real keyboard shortcut cannot be pressed reliably from Playwright (browser-level commands are not page keys), so
 * the shortcut's path is driven through the `priorityCommand` message: the worker's chrome.commands.onCommand listener
 * sends exactly that request for the active tab (src/background/index.ts), and it runs the same code.
 */
import { expect, test } from '@playwright/test';
import { escapeRe, navButton, rpc } from './fixtures/launch';
import { PAGES } from './fixtures/server';
import { Harness } from './fixtures/ui';
import { PRIORITY_GROUP_ID } from '../../src/shared/priority';

let h: Harness;
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
const titleOf = (slug: string) => PAGES.find((p) => p.slug === slug)!.title;
const groupsNav = () => page().getByRole('list', { name: 'Groups', exact: true });

test('PR-01 the shortcut path adds the tab to Priority (badge ★, listed first in the dashboard); removing puts it back', async () => {
  const url = h.url('ai-rag-pipeline');
  const other = h.url('rust-async-tokio');
  await h.open([url, other]);
  const before = await h.item(url);
  const [tab] = await h.tabsAt(url);
  expect(tab).toBeDefined();

  await test.step('add: the tab is in Priority, the badge says ★ for a moment, nothing was taught', async () => {
    expect(await rpc(page(), { t: 'priorityCommand', command: 'prioritize-tab', tabId: tab!.id })).toBe('added');
    await expect.poll(async () => (await h.tabsAt(url))[0]?.badge).toBe('★');
    const it = await h.item(url);
    expect([it.groupId, it.groupSource]).toEqual([PRIORITY_GROUP_ID, 'user']);
    expect(await rpc(page(), { t: 'priorityCommand', command: 'prioritize-tab', tabId: tab!.id })).toBe('none'); // again: no-op
    // After the moment, the badge shows what it showed before (no duplicate, nothing suspicious: nothing).
    await expect.poll(async () => (await h.tabsAt(url))[0]?.badge, { timeout: 10_000 }).toBe('');
  });

  await test.step('the dashboard lists Priority first with the tab in it', async () => {
    await expect(groupsNav().locator('.nav-item').first()).toHaveText(/^Priority\s*1$/);
    await navButton(page(), 'Priority').click();
    await expect(page().getByRole('heading', { level: 1 })).toHaveText('Priority');
    const list = page().getByRole('list', { name: 'Priority', exact: true });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list.getByRole('listitem').filter({ hasText: titleOf('ai-rag-pipeline') })).toHaveCount(1);
    await expect(page().getByRole('button', { name: 'Delete group' })).toHaveCount(0);
  });

  await test.step('remove: back in the group it was in; the empty Priority entry leaves the sidebar', async () => {
    expect(await rpc(page(), { t: 'priorityCommand', command: 'unprioritize-tab', tabId: tab!.id })).toBe('removed');
    await expect.poll(async () => (await h.item(url)).groupId).toBe(before.groupId);
    expect((await h.item(url)).groupSource).toBe(before.groupSource);
    await expect.poll(async () => (await h.tabsAt(url))[0]?.badge).toBe('–');
    await expect(page().getByText('Nothing in Priority.', { exact: false })).toBeVisible(); // still on its page
    await page().getByRole('navigation', { name: 'Views and groups' }).getByRole('button', { name: /^All tabs/ }).click();
    await expect(groupsNav().getByRole('button', { name: /^Priority(\s|$)/ })).toHaveCount(0);
    expect(await rpc(page(), { t: 'priorityCommand', command: 'unprioritize-tab', tabId: tab!.id })).toBe('none');
  });

  await test.step('a browser page is left alone', async () => {
    const own = (await h.tabs()).find((t) => t.url.startsWith(`chrome-extension://${h.extId}/`))!;
    expect(await rpc(page(), { t: 'priorityCommand', command: 'prioritize-tab', tabId: own.id })).toBe('none');
  });
});

test('PR-02 the star on a row adds it to Priority and takes it out again', async () => {
  const url = h.url('travel-kyoto-itinerary');
  await h.open([url]);
  const before = await h.item(url);
  const title = titleOf('travel-kyoto-itinerary');
  const row = page().getByRole('list', { name: 'All tabs', exact: true }).getByRole('listitem').filter({ hasText: new RegExp(escapeRe(title)) });
  await row.hover();
  await row.getByRole('button', { name: 'Add to Priority' }).click();
  await expect.poll(async () => (await h.item(url)).groupId).toBe(PRIORITY_GROUP_ID);
  await expect(page().locator('.toast')).toContainText('Added 1 tab to Priority');
  await row.hover();
  await row.getByRole('button', { name: 'Remove from Priority' }).click();
  await expect.poll(async () => (await h.item(url)).groupId).toBe(before.groupId);
});
