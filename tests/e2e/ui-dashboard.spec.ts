/**
 * Dashboard, end to end: every view and every control of the BUILT extension (dist/) in real Chromium, operated
 * the way a user would (clicks, typing, drag and drop). Run `npm run build` first. The IDs (D-…) are the rows of
 * docs/testing/ui-test-cases.md.
 *
 * One browser for the file; each test starts from reset() (fixtures/ui.ts): only the dashboard tab, no data.
 */
import { expect, test, type Locator } from '@playwright/test';
import { HINTS } from '../../src/ui/common/hints';
import { escapeRe, navButton, rpc } from './fixtures/launch';
import { PAGES, TOPIC_PAGES, TOPIC_PAGES_2 } from './fixtures/server';
import { FAULTS_SCRIPT, Harness, backup } from './fixtures/ui';

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

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────
const page = () => h.dash;
const heading = () => page().getByRole('heading', { level: 1 });
const list = (name: string) => page().getByRole('list', { name, exact: true });
const rowIn = (l: Locator, title: string) => l.getByRole('listitem').filter({ hasText: title });
const toast = () => page().locator('.toast');
const dialog = (name: string | RegExp) => page().getByRole('dialog', { name });
const bySlug = (slug: string) => PAGES.find((p) => p.slug === slug)!;
const urlOf = (slug: string) => h.url(slug);
const titleOf = (slug: string) => bySlug(slug).title;
const subtitle = () => page().locator('.view-sub > span').first();
const selectionBar = () => page().getByRole('toolbar', { name: 'Selected tabs' });

/** Opens pages by slug and returns their group names (as classified), keyed by slug. */
async function openSlugs(slugs: string[]): Promise<Map<string, string | undefined>> {
  await h.open(slugs.map(urlOf));
  const out = new Map<string, string | undefined>();
  for (const s of slugs) out.set(s, await h.groupName((await h.item(urlOf(s))).groupId));
  return out;
}
/** Polls the URLs of the open tabs of the test server. */
const serverUrls = async () => (await h.tabs()).map((t) => t.url).filter((u) => u.startsWith(h.server.origin)).sort();

// ── navigation and views ────────────────────────────────────────────────────────────────────────────────

test('D-01..D-04 sidebar views, counts, routing by address, unknown group, All subtitle', async () => {
  const a = urlOf('ai-rag-pipeline');
  await h.open([a, a, urlOf('travel-kyoto-itinerary')]);
  await expect(navButton(page(), 'All tabs')).toHaveText(/^All tabs\s*3$/);
  await expect(navButton(page(), 'Duplicates')).toHaveText(/^Duplicates\s*1$/);
  await expect(navButton(page(), 'Saved for later')).toHaveText(/^Saved for later$/); // no count when empty
  await expect(navButton(page(), 'Suspicious')).toHaveCount(0);
  await expect(subtitle()).toHaveText('3 tabs · 1 window · 0 paused · 0 saved · 3 new');
  const views: [string, string][] = [
    ['Unsorted', 'unsorted'], ['Duplicates', 'duplicates'], ['Saved for later', 'stashed'], ['Sessions', 'sessions'],
    ['Settings', 'settings'], ['All tabs', 'all'],
  ];
  for (const [name, hash] of views) {
    await navButton(page(), name).click();
    await expect(heading()).toHaveText(name);
    expect(page().url()).toBe(h.dashUrl(`view=${hash}`));
    await expect(navButton(page(), name)).toHaveAttribute('aria-current', 'page');
  }
  // The address picks the view: a reload stays where it was.
  await navButton(page(), 'Saved for later').click();
  await page().reload();
  await expect(heading()).toHaveText('Saved for later');
  // A group that does not exist (an old link).
  await page().goto(h.dashUrl('group=no-such-group'));
  await expect(heading()).toHaveText('Group not found');
  await expect(page().getByText('This group no longer exists.')).toBeVisible();
  await page().getByRole('button', { name: 'Show all tabs' }).click();
  await expect(heading()).toHaveText('All tabs');
});

test('D-05 “Show new only” narrows the list to tabs never switched to', async () => {
  const urls = ['ai-rag-pipeline', 'travel-kyoto-itinerary', 'music-jazz-playlist'].map(urlOf);
  await h.open(urls);
  await expect(subtitle()).toContainText('3 new');
  // Switching to a tab makes it no longer new.
  await rowIn(list('All tabs'), titleOf('ai-rag-pipeline')).locator('.item-main').click();
  await expect.poll(async () => (await h.item(urls[0]!)).opened).toBe(true);
  await page().bringToFront();
  await expect(subtitle()).toContainText('2 new');
  const filter = page().getByRole('button', { name: 'Show new only' });
  await filter.click();
  await expect(list('All tabs').getByRole('listitem')).toHaveCount(2);
  await expect(rowIn(list('All tabs'), titleOf('ai-rag-pipeline'))).toHaveCount(0);
  await expect(page().getByRole('button', { name: 'Show all' })).toHaveAttribute('aria-pressed', 'true');
  await page().getByRole('button', { name: 'Show all' }).click();
  await expect(list('All tabs').getByRole('listitem')).toHaveCount(3);
});

// ── row actions ─────────────────────────────────────────────────────────────────────────────────────────

test('D-10..D-12 Pause a tab (hint only the first time), then close the paused tab and Undo', async () => {
  const [a, b] = ['ai-rag-pipeline', 'travel-kyoto-itinerary'];
  await h.open([urlOf(a), urlOf(b)]);
  const all = list('All tabs');
  await rowIn(all, titleOf(a)).getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(toast()).toContainText('Paused 1 tab');
  await expect(toast()).toContainText(HINTS.pause);
  await expect(rowIn(all, titleOf(a)).locator('.state-sleeping')).toHaveText('Paused');
  await expect.poll(async () => (await h.tabsAt(urlOf(a))).map((t) => t.discarded)).toEqual([true]);
  // A paused tab has no Pause button; the second Pause shows no hint.
  await expect(rowIn(all, titleOf(a)).getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
  await rowIn(all, titleOf(b)).getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(toast()).toContainText('Paused 1 tab');
  await expect(toast()).not.toContainText(HINTS.pause);
  await expect(subtitle()).toContainText('2 paused');
  // Sleeping, then closing.
  await rowIn(all, titleOf(a)).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(toast()).toContainText('Closed 1 tab');
  await expect.poll(() => h.tabsAt(urlOf(a))).toHaveLength(0);
  await expect(rowIn(all, titleOf(a))).toHaveCount(0);
  await toast().getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await h.tabsAt(urlOf(a))).length).toBe(1);
  await expect(toast()).toContainText('Undone');
  await expect(rowIn(all, titleOf(a))).toHaveCount(1);
});

test('D-13..D-15 Save for later from a group, Undo, then save again and reopen from Saved for later: back in its group', async () => {
  const slugs = ['ai-rag-pipeline', 'ai-langgraph-agent-tutorial'];
  const groups = await openSlugs(slugs);
  const group = groups.get(slugs[0]!)!;
  expect(group, 'classified into a group').toBeTruthy();
  await navButton(page(), group).click();
  await expect(heading()).toHaveText(group);
  const g = list(group);
  const title = titleOf(slugs[0]!);
  // Save, then Undo: the tab comes back in the same group, nothing stays saved.
  await rowIn(g, title).getByRole('button', { name: 'Save for later' }).click();
  await expect(toast()).toContainText('Saved 1 tab for later');
  await expect(toast()).toContainText(HINTS.save);
  await expect.poll(() => h.tabsAt(urlOf(slugs[0]!))).toHaveLength(0);
  await expect(rowIn(g, title).locator('.state-stashed')).toHaveText('Saved'); // still listed in its group, as saved
  await toast().getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await h.tabsAt(urlOf(slugs[0]!))).length).toBe(1);
  await expect.poll(async () => (await h.state()).items.filter((i) => i.state === 'stashed').length).toBe(0);
  await expect.poll(async () => h.groupName((await h.item(urlOf(slugs[0]!))).groupId)).toBe(group);
  // Save again (no hint the second time), then open it from Saved for later.
  await rowIn(g, title).getByRole('button', { name: 'Save for later' }).click();
  await expect(toast()).toContainText('Saved 1 tab for later');
  await expect(toast()).not.toContainText(HINTS.save);
  await expect(navButton(page(), 'Saved for later')).toHaveText(/^Saved for later\s*1$/);
  await navButton(page(), 'Saved for later').click();
  const saved = list('Saved for later');
  await rowIn(saved, title).getByRole('button', { name: 'Open', exact: true }).click();
  await expect.poll(async () => (await h.tabsAt(urlOf(slugs[0]!))).length).toBe(1);
  await expect(rowIn(saved, title)).toHaveCount(0); // "Remove … when I open it" is on by default
  await expect.poll(async () => h.groupName((await h.item(urlOf(slugs[0]!))).groupId)).toBe(group);
});

test('D-16..D-18 Move to group: the row button, the drag onto a group, and a new group from the selection', async () => {
  const [a, b, c] = ['travel-kyoto-itinerary', 'music-jazz-playlist', 'finance-roth-ira'];
  await openSlugs([a, b, c]);
  const all = list('All tabs');
  // Row button: selects the row and focuses the "Move to…" menu.
  await rowIn(all, titleOf(a)).getByRole('button', { name: 'Move to group' }).click();
  await expect(selectionBar()).toContainText('1 selected');
  const move = page().getByRole('combobox', { name: 'Move selected tabs to group' });
  await expect(move).toBeFocused();
  await move.selectOption({ label: 'Games' });
  await expect(toast()).toContainText('Moved 1 tab to Games');
  await expect.poll(async () => { const i = await h.item(urlOf(a)); return [i.groupId, i.groupSource]; }).toEqual(['games', 'user']);
  await expect(selectionBar()).toHaveCount(0);
  // Drag and drop onto a group in the sidebar.
  await rowIn(all, titleOf(b)).dragTo(navButton(page(), 'News'));
  await expect(toast()).toContainText('Moved 1 tab to News');
  await expect.poll(async () => (await h.item(urlOf(b))).groupId).toBe('news');
  // New group from two selected tabs: the name is required.
  await rowIn(all, titleOf(b)).getByRole('checkbox').check();
  await rowIn(all, titleOf(c)).getByRole('checkbox').check();
  await expect(selectionBar()).toContainText('2 selected');
  await selectionBar().getByRole('button', { name: 'New group' }).click();
  const d = dialog('New group');
  await expect(d.getByRole('button', { name: 'Create group' })).toBeDisabled();
  await d.getByRole('textbox', { name: 'Name' }).fill('   ');
  await expect(d.getByRole('button', { name: 'Create group' })).toBeDisabled();
  await d.getByRole('textbox', { name: 'Name' }).fill('Reading pile');
  await d.getByRole('button', { name: 'Create group' }).click();
  await expect(toast()).toContainText('Created Reading pile with 2 tabs');
  await expect(navButton(page(), 'Reading pile')).toHaveText(/^Reading pile\s*2$/);
});

test('D-19..D-21 selection: checkbox, Shift range, Ctrl toggle, Clear; bar Pause, Save for later and Close (Undo)', async () => {
  const slugs = ['travel-kyoto-itinerary', 'music-jazz-playlist', 'finance-roth-ira', 'games-steam-sale'];
  await openSlugs(slugs);
  const rows = list('All tabs').getByRole('listitem');
  await expect(rows).toHaveCount(4);
  await rows.nth(0).getByRole('checkbox').check();
  await rows.nth(2).getByRole('checkbox').click({ modifiers: ['Shift'] });
  await expect(selectionBar()).toContainText('3 selected');
  await rows.nth(3).locator('.item-main').click({ modifiers: ['ControlOrMeta'] });
  await expect(selectionBar()).toContainText('4 selected');
  await rows.nth(3).locator('.item-main').click({ modifiers: ['ControlOrMeta'] });
  await expect(selectionBar()).toContainText('3 selected');
  await selectionBar().getByRole('button', { name: 'Clear' }).click();
  await expect(selectionBar()).toHaveCount(0);
  // Pause two.
  await rows.nth(0).getByRole('checkbox').check();
  await rows.nth(1).getByRole('checkbox').check();
  await selectionBar().getByRole('button', { name: 'Pause' }).click();
  await expect(toast()).toContainText('Paused 2 tabs');
  await expect.poll(async () => (await h.state()).sleeping).toBe(2);
  // Save those two for later (paused tabs can be saved too).
  await selectionBar().getByRole('button', { name: 'Save for later' }).click();
  await expect(toast()).toContainText('Saved 2 tabs for later');
  await expect.poll(async () => (await serverUrls()).length).toBe(2);
  // Close the other two, then Undo.
  await page().getByRole('list', { name: 'All tabs' }).getByRole('listitem').filter({ hasNot: page().locator('.state-stashed') })
    .getByRole('checkbox').evaluateAll((els) => els.forEach((e) => (e as HTMLInputElement).click()));
  await expect(selectionBar()).toContainText('2 selected');
  await selectionBar().getByRole('button', { name: 'Close' }).click();
  await expect(toast()).toContainText('Closed 2 tabs');
  await expect.poll(serverUrls).toEqual([]);
  await toast().getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await serverUrls()).length).toBe(2);
});

test('D-22..D-23 more than 20 selected: Open asks first; the bar removes saved tabs', async () => {
  const items = Array.from({ length: 21 }, (_, n) => ({ url: h.url(PAGES[n]!.slug), title: PAGES[n]!.title }));
  await h.importBackup(backup({ items }));
  await expect(toast()).toContainText('Imported 21 tabs');
  await navButton(page(), 'Saved for later').click();
  const rows = list('Saved for later').getByRole('listitem');
  await expect(rows).toHaveCount(21);
  await rows.first().getByRole('checkbox').check();
  await rows.last().getByRole('checkbox').click({ modifiers: ['Shift'] });
  await expect(selectionBar()).toContainText('21 selected');
  await selectionBar().getByRole('button', { name: 'Open' }).click();
  const d = dialog('Open 21 tabs?');
  await expect(d).toContainText('Each one starts loading');
  await d.getByRole('button', { name: 'Cancel' }).click();
  await expect(d).toHaveCount(0);
  expect(await serverUrls()).toEqual([]);
  // Remove two of them from the bar.
  await selectionBar().getByRole('button', { name: 'Clear' }).click();
  await rows.nth(0).getByRole('checkbox').check();
  await rows.nth(1).getByRole('checkbox').check();
  await selectionBar().getByRole('button', { name: 'Remove from Saved for later' }).click();
  await expect(toast()).toContainText('Removed 2 saved tabs');
  await expect(rows).toHaveCount(19);
  // 19 open without asking.
  await rows.first().getByRole('checkbox').check();
  await rows.last().getByRole('checkbox').click({ modifiers: ['Shift'] });
  await selectionBar().getByRole('button', { name: 'Open' }).click();
  await expect.poll(async () => (await serverUrls()).length).toBe(19);
  await expect(dialog(/^Open/)).toHaveCount(0);
});

// ── Saved for later ─────────────────────────────────────────────────────────────────────────────────────

test('D-30..D-32 Saved for later: Remove one with Undo; Remove all asks, Cancel keeps, confirm empties, Undo restores', async () => {
  const slugs = ['recipe-sourdough-bread', 'recipe-chicken-curry', 'recipe-chocolate-chip-cookies'];
  await h.importBackup(backup({ items: slugs.map((s) => ({ url: urlOf(s), title: titleOf(s) })) }));
  await expect(toast()).toContainText('Imported 3 tabs');
  await navButton(page(), 'Saved for later').click();
  const saved = list('Saved for later');
  await expect(saved.getByRole('listitem')).toHaveCount(3);
  await expect(subtitle()).toHaveText('3 items');
  await rowIn(saved, titleOf(slugs[0]!)).getByRole('button', { name: 'Remove from Saved for later' }).click();
  await expect(toast()).toContainText('Removed 1 saved tab');
  await expect(saved.getByRole('listitem')).toHaveCount(2);
  await toast().getByRole('button', { name: 'Undo' }).click();
  await expect(saved.getByRole('listitem')).toHaveCount(3);
  await page().getByRole('button', { name: 'Remove all' }).click();
  let d = dialog('Remove 3 saved tabs?');
  await expect(d.getByRole('button', { name: 'Cancel' })).toBeFocused(); // destructive: Cancel has the focus
  await d.getByRole('button', { name: 'Cancel' }).click();
  await expect(saved.getByRole('listitem')).toHaveCount(3);
  await page().getByRole('button', { name: 'Remove all' }).click();
  d = dialog('Remove 3 saved tabs?');
  await d.getByRole('button', { name: 'Remove all' }).click();
  await expect(page().getByText('Nothing saved yet.', { exact: false })).toBeVisible();
  await expect(page().getByRole('button', { name: 'Remove all' })).toHaveCount(0);
  await toast().getByRole('button', { name: 'Undo' }).click();
  await expect(saved.getByRole('listitem')).toHaveCount(3);
});

// ── search ──────────────────────────────────────────────────────────────────────────────────────────────

test('D-40..D-43 search: by words, typo, a saved tab (opens it), “No matches”, Esc clears', async () => {
  await h.open([urlOf('ai-rag-pipeline'), urlOf('travel-kyoto-itinerary')]);
  await h.importBackup(backup({ items: [{ url: urlOf('recipe-sourdough-bread'), title: titleOf('recipe-sourdough-bread') }] }));
  await expect(toast()).toContainText('Imported 1 tab');
  await navButton(page(), 'All tabs').click();
  const box = page().getByRole('searchbox', { name: 'Search tabs' });
  await box.fill('kyoto');
  await expect(heading()).toHaveText('Results for “kyoto”');
  await expect(rowIn(list('Results for “kyoto”'), titleOf('travel-kyoto-itinerary'))).toHaveCount(1);
  await box.fill('kyotto'); // a typo still finds it
  await expect(rowIn(list('Results for “kyotto”'), titleOf('travel-kyoto-itinerary'))).toHaveCount(1);
  // A saved tab is found too, marked Saved; clicking it opens it.
  await box.fill('sourdough');
  const res = list('Results for “sourdough”');
  const hit = rowIn(res, titleOf('recipe-sourdough-bread'));
  await expect(hit.locator('.state-stashed')).toHaveText('Saved');
  await hit.locator('.item-main').click();
  await expect.poll(async () => (await h.tabsAt(urlOf('recipe-sourdough-bread'))).length).toBe(1);
  await page().bringToFront();
  await box.fill('qqzzxxv');
  await expect(page().getByText('No matches')).toBeVisible();
  await expect(subtitle()).toHaveText('0 matches');
  await box.press('Escape');
  await expect(box).toHaveValue('');
  await expect(heading()).toHaveText('All tabs');
});

test('D-44 search by meaning: a word in no title finds related tabs, marked “Similar by meaning”', async () => {
  const savings = ['finance-index-funds', 'finance-roth-ira'];
  await h.open([...savings, 'travel-kyoto-itinerary', 'games-steam-sale', 'music-jazz-playlist'].map(urlOf));
  const q = 'pension';
  // The word is in none of the titles or addresses: anything listed is found by meaning.
  for (const i of (await h.state()).items) expect(`${i.title} ${i.url}`.toLowerCase()).not.toContain(q);
  await page().getByRole('searchbox', { name: 'Search tabs' }).fill(q);
  const rows = list(`Results for “${q}”`).getByRole('listitem');
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toContainText('Similar by meaning');
  expect(await rows.filter({ hasNotText: 'Similar by meaning' }).count()).toBe(0);
  // The best match by meaning is one of the retirement-savings pages.
  await expect(rows.first()).toContainText(new RegExp(savings.map((t) => escapeRe(titleOf(t))).join('|')));
});
// ── groups ──────────────────────────────────────────────────────────────────────────────────────────────

test('D-50..D-55 group view: Pause group, Rename, Merge, Delete (tabs stay open); Other cannot be deleted', async () => {
  const slugs = ['travel-kyoto-itinerary', 'travel-iceland-ring-road', 'travel-packing-list'];
  const groups = await openSlugs(slugs);
  const group = groups.get(slugs[0]!)!;
  expect([...groups.values()]).toEqual([group, group, group]);
  await navButton(page(), group).click();
  await expect(heading()).toHaveText(group);
  await expect(subtitle()).toHaveText('3 items · 3 new');
  await page().getByRole('button', { name: 'Pause group' }).click();
  await expect(toast()).toContainText('Paused 3 tabs');
  // Rename: the name is prefilled and required.
  await page().getByRole('button', { name: 'Rename group' }).click();
  let d = dialog(`Rename ${group}`);
  const name = d.getByRole('textbox', { name: 'Name' });
  await expect(name).toHaveValue(group);
  await name.fill('');
  await expect(d.getByRole('button', { name: 'Rename' })).toBeDisabled();
  await name.fill('Trips');
  await name.press('Enter');
  await expect(heading()).toHaveText('Trips');
  await expect(navButton(page(), 'Trips')).toHaveText(/^Trips\s*3$/);
  // Merge into Finance.
  await page().getByRole('button', { name: 'Merge group' }).click();
  d = dialog('Merge Trips into…');
  await d.getByRole('combobox', { name: 'Merge into' }).selectOption({ label: 'Finance' });
  await d.getByRole('button', { name: 'Merge' }).click();
  await expect(heading()).toHaveText('Finance');
  await expect(navButton(page(), 'Trips')).toHaveCount(0);
  await expect(navButton(page(), 'Finance')).toHaveText(/^Finance\s*3$/);
  // Delete: Cancel keeps it; confirming removes the group, the tabs stay open.
  await page().getByRole('button', { name: 'Delete group' }).click();
  d = dialog('Delete Finance?');
  await expect(d).toContainText('Its 3 tabs go back to Unsorted');
  await d.getByRole('button', { name: 'Cancel' }).click();
  await expect(navButton(page(), 'Finance')).toBeVisible();
  await page().getByRole('button', { name: 'Delete group' }).click();
  await dialog('Delete Finance?').getByRole('button', { name: 'Delete group' }).click();
  await expect(heading()).toHaveText('All tabs');
  await expect(navButton(page(), 'Finance')).toHaveCount(0);
  expect(await serverUrls()).toHaveLength(3);
  // "Other" is permanent: no Delete; an empty group explains how to fill it.
  await navButton(page(), 'Other').click();
  await expect(page().getByRole('button', { name: 'Rename group' })).toBeVisible();
  await expect(page().getByRole('button', { name: 'Delete group' })).toHaveCount(0);
  await expect(page().getByText('No tabs in this group yet. Drag tabs here to teach it.')).toBeVisible();
});

test('D-56 Save group for later closes the group’s tabs and keeps them in Saved for later', async () => {
  const slugs = ['music-jazz-playlist', 'music-learn-guitar-chords', 'travel-kyoto-itinerary'];
  const groups = await openSlugs(slugs);
  const group = groups.get(slugs[0]!)!;
  const inGroup = slugs.filter((s) => groups.get(s) === group);
  await navButton(page(), group).click();
  await page().getByRole('button', { name: 'Save group for later' }).click();
  await expect(toast()).toContainText(`Saved ${inGroup.length} tabs for later`);
  await expect.poll(serverUrls).toEqual(slugs.filter((s) => !inGroup.includes(s)).map(urlOf).sort());
  await expect(page().getByRole('button', { name: 'Save group for later' })).toBeDisabled(); // nothing open left
});

test('D-57 videos to watch: the group shows “▶ N”, the row shows where the video was left off', async () => {
  // Saved tabs (never loaded, so no network): two videos and an article in one group.
  const items = [
    { url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa&t=754', title: 'Lecture 1: introduction', group: 'Watch later' },
    { url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', title: 'Lecture 2: practice', group: 'Watch later' },
    { url: urlOf('ai-rag-pipeline'), title: titleOf('ai-rag-pipeline'), group: 'Watch later' },
  ];
  await h.importBackup(backup({ items, groups: ['Watch later'] }));
  await expect(toast()).toContainText('Imported 3 tabs');
  const nav = navButton(page(), 'Watch later');
  await expect(nav.getByLabel('2 to watch')).toHaveText('2');
  await nav.click();
  await expect(subtitle()).toHaveText('3 items · 2 to watch');
  await expect(rowIn(list('Watch later'), 'Lecture 1')).toContainText('from 12:34');
  await expect(rowIn(list('Watch later'), 'Lecture 2')).not.toContainText('from ');
  const popup = await h.openPage('popup.html');
  await expect(popup.getByRole('list', { name: 'Top groups' }).getByRole('listitem').filter({ hasText: 'Watch later' })).toContainText('2 to watch');
});
test('D-60..D-62 suggested group: shown under “Suggested groups”, Dismiss sends the tabs back to Unsorted and it does not come back', async () => {
  await h.open(TOPIC_PAGES.map((p) => h.url(p.slug)));
  await expect.poll(async () => (await h.state()).groups.filter((g) => g.suggested).length, { timeout: 60_000 }).toBe(1);
  const sug = (await h.state()).groups.find((g) => g.suggested)!;
  const section = page().getByRole('region', { name: 'Suggested groups' }).or(page().locator('section.suggestions'));
  await expect(section.getByRole('button', { name: new RegExp(`^${escapeRe(sug.name)}`) })).toBeVisible();
  await section.getByRole('button', { name: new RegExp(`^${escapeRe(sug.name)}`) }).click();
  await expect(heading()).toHaveText(sug.name);
  await expect(page().locator('.view-title-row .status-pill')).toHaveText('Suggested');
  await expect(page().getByRole('button', { name: 'Accept group' })).toBeVisible();
  await page().getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page().locator('section.suggestions')).toHaveCount(0);
  await navButton(page(), 'Unsorted').click();
  await expect(list('Unsorted').getByRole('listitem')).toHaveCount(TOPIC_PAGES.length);
  // Unsorted offers the group actions too.
  await expect(page().getByRole('button', { name: 'Save group for later' })).toBeEnabled();
  await expect(page().getByRole('button', { name: 'Pause group' })).toBeEnabled();
  // Proof that a suggestion pass ran after the dismiss: a second new topic (knitting) gets suggested. That pass also
  // saw the beekeeping tabs (still Unsorted), and they must not be suggested again.
  const knitting = TOPIC_PAGES_2.map((p) => h.url(p.slug));
  await h.open(knitting);
  await expect.poll(async () => (await h.state()).groups.filter((g) => g.suggested).length, { timeout: 60_000 }).toBe(1);
  const s = await h.state();
  const again = s.groups.find((g) => g.suggested)!;
  const members = s.items.filter((i) => i.groupId === again.id).map((i) => i.url).sort();
  expect(members.length).toBeGreaterThan(0);
  expect(members.every((u) => knitting.includes(u)), `the new suggestion holds only knitting tabs: ${members.join(', ')}`).toBe(true);
  const bees = TOPIC_PAGES.map((p) => h.url(p.slug));
  expect(s.items.filter((i) => bees.includes(i.url)).map((i) => i.groupId)).toEqual(bees.map(() => null));
  await expect(page().locator('section.suggestions')).toContainText(again.name);
  await expect(page().locator('section.suggestions').getByRole('listitem')).toHaveCount(1);
});

test('D-63 suggested group: Accept from the sidebar makes it a normal group', async () => {
  await h.open(TOPIC_PAGES.map((p) => h.url(p.slug)));
  await expect.poll(async () => (await h.state()).groups.filter((g) => g.suggested).length, { timeout: 60_000 }).toBe(1);
  const sug = (await h.state()).groups.find((g) => g.suggested)!;
  await page().getByRole('button', { name: `Accept ${sug.name}` }).click();
  await expect(page().locator('section.suggestions')).toHaveCount(0);
  await expect(navButton(page(), sug.name)).toHaveText(new RegExp(`^${escapeRe(sug.name)}\\s*${sug.count}$`));
  await navButton(page(), sug.name).click();
  await expect(page().getByRole('button', { name: 'Rename group' })).toBeVisible();
  await expect(page().locator('.view-title-row .status-pill')).toHaveCount(0);
});

// ── duplicates ──────────────────────────────────────────────────────────────────────────────────────────

test('D-70..D-73 a tab that is both a duplicate and in a group: listed with its group; Close duplicates (Cancel, confirm, Undo)', async () => {
  const u = urlOf('ai-rag-pipeline');
  await h.open([u, u, urlOf('travel-kyoto-itinerary')]);
  const group = (await h.groupName((await h.item(u)).groupId))!;
  await expect(navButton(page(), group)).toContainText('2');
  await navButton(page(), 'Duplicates').click();
  await expect(subtitle()).toHaveText('1 extra copy');
  const dups = list('Duplicates').getByRole('listitem');
  await expect(dups).toHaveCount(2);
  for (const r of await dups.all()) await expect(r.locator('.chip, .group-chip').first()).toContainText(group);
  await page().getByRole('button', { name: 'Close duplicates' }).click();
  let d = dialog('Close 1 duplicate tab?');
  await d.getByRole('button', { name: 'Cancel' }).click();
  expect(await h.tabsAt(u)).toHaveLength(2);
  await page().getByRole('button', { name: 'Close duplicates' }).click();
  d = dialog('Close 1 duplicate tab?');
  await d.getByRole('button', { name: 'Close duplicates' }).click();
  await expect(toast()).toContainText('Closed 1 duplicate tab');
  await expect.poll(() => h.tabsAt(u)).toHaveLength(1);
  await expect(page().getByText('No page is open more than once.')).toBeVisible();
  await expect(page().getByRole('button', { name: 'Close duplicates' })).toBeDisabled();
  await expect(navButton(page(), group)).toHaveText(new RegExp(`^${escapeRe(group)}\\s*1$`));
  await toast().getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => h.tabsAt(u)).toHaveLength(2);
  await expect(dups).toHaveCount(2);
});

test('D-74 Re-group everything: preview, Cancel changes nothing, Apply reports the result', async () => {
  await h.open(['ai-rag-pipeline', 'travel-kyoto-itinerary', 'music-jazz-playlist'].map(urlOf));
  const before = (await h.state()).items.map((i) => i.groupId).sort();
  await page().getByRole('button', { name: 'Re-group everything' }).click();
  const d = dialog('Re-group everything');
  await expect(d).toBeVisible();
  const apply = d.getByRole('button', { name: 'Apply' });
  if (await apply.count()) {
    await d.getByRole('button', { name: 'Cancel' }).click();
    expect((await h.state()).items.map((i) => i.groupId).sort()).toEqual(before);
    await page().getByRole('button', { name: 'Re-group everything' }).click();
    await dialog('Re-group everything').getByRole('button', { name: 'Apply' }).click();
    await expect(toast()).toContainText(/Re-grouped \d+ tabs?|Nothing needed to move/);
  } else {
    await expect(d).toContainText('Nothing to change');
    await d.getByRole('button', { name: 'Close' }).click();
    await expect(d).toHaveCount(0);
  }
});

// ── sessions ────────────────────────────────────────────────────────────────────────────────────────────

test('D-80..D-84 Sessions: empty, Save session now, Open all, Save all for later, Delete (Cancel, confirm)', async () => {
  await navButton(page(), 'Sessions').click();
  await expect(page().getByText('No sessions saved yet.')).toBeVisible();
  await page().getByRole('button', { name: 'Save session now' }).click();
  await expect(toast()).toContainText('No web tabs to save');
  const urls = ['ai-rag-pipeline', 'travel-kyoto-itinerary'].map(urlOf);
  await h.open(urls);
  await page().getByRole('button', { name: 'Save session now' }).click();
  await expect(toast()).toContainText('Session saved');
  const sessions = list('Saved sessions').getByRole('listitem');
  await expect(sessions).toHaveCount(1);
  await expect(sessions.first()).toContainText('just now · 1 window · 2 tabs');
  // Close the tabs, then Open all: a new window with both.
  await page().evaluate(async (us) => {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.filter((t) => us.includes(t.url ?? '')).map((t) => chrome.tabs.remove(t.id!)));
  }, urls);
  await expect.poll(serverUrls).toEqual([]);
  const windowsBefore = await page().evaluate(() => chrome.windows.getAll().then((w) => w.length));
  await sessions.first().getByRole('button', { name: 'Open all' }).click();
  await expect.poll(serverUrls).toEqual([...urls].sort());
  expect(await page().evaluate(() => chrome.windows.getAll().then((w) => w.length))).toBe(windowsBefore + 1);
  await page().bringToFront();
  await sessions.first().getByRole('button', { name: 'Save all for later' }).click();
  await expect(toast()).toContainText('Saved the session’s 2 tabs for later');
  await expect(navButton(page(), 'Saved for later')).toHaveText(/^Saved for later\s*2$/);
  // Delete asks first.
  await sessions.first().getByRole('button', { name: /^Delete session from/ }).click();
  let d = dialog('Delete this session?');
  await d.getByRole('button', { name: 'Cancel' }).click();
  await expect(sessions).toHaveCount(1);
  await sessions.first().getByRole('button', { name: /^Delete session from/ }).click();
  d = dialog('Delete this session?');
  await d.getByRole('button', { name: 'Delete session' }).click();
  await expect(page().getByText('No sessions saved yet.')).toBeVisible();
});

test('D-86 a session of more than 20 tabs asks before opening them all', async () => {
  const tabs = Array.from({ length: 21 }, (_, n) => ({ url: h.url(PAGES[n]!.slug), title: PAGES[n]!.title }));
  await h.importBackup(backup({ snapshots: [{ takenAt: Date.now() - 3_600_000, windows: [tabs] }] }));
  await expect(toast()).toContainText('Imported 0 tabs');
  await navButton(page(), 'Sessions').click();
  const sessions = list('Saved sessions').getByRole('listitem');
  await expect(sessions.first()).toContainText('1 window · 21 tabs');
  await sessions.first().getByRole('button', { name: 'Open all' }).click();
  const d = dialog('Open 21 tabs?');
  await expect(d).toContainText('They open in a new window');
  await d.getByRole('button', { name: 'Cancel' }).click();
  await expect(d).toHaveCount(0);
  expect(await serverUrls()).toEqual([]);
  await sessions.first().getByRole('button', { name: 'Open all' }).click();
  await dialog('Open 21 tabs?').getByRole('button', { name: 'Open 21 tabs' }).click();
  await expect.poll(async () => (await serverUrls()).length).toBe(21);
});

test('D-87..D-88 “Your last session wasn’t restored” card: Dismiss (stays dismissed), Save all for later', async () => {
  const urls = ['ai-rag-pipeline', 'travel-kyoto-itinerary'].map(urlOf);
  await h.open(urls);
  const snap = await rpc<{ id: string }>(page(), { t: 'snapshotNow' });
  // What the startup check records when the browser did not restore that session.
  const flag = () => page().evaluate((id) => chrome.storage.session.set({ lastSession: { snapshotId: id } }), snap.id);
  await flag();
  await page().reload();
  const card = page().getByRole('region', { name: 'Your last session (2 tabs) wasn’t restored' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(card).toHaveCount(0);
  await page().reload();
  await expect(heading()).toHaveText('All tabs');
  await expect(card).toHaveCount(0);
  await flag();
  await page().reload();
  await card.getByRole('button', { name: 'Save all for later' }).click();
  await expect(toast()).toContainText('Saved the session’s 2 tabs for later');
  await expect.poll(async () => (await h.state()).items.filter((i) => i.state === 'stashed').map((i) => i.url).sort()).toEqual([...urls].sort());
});

// ── error and loading states ────────────────────────────────────────────────────────────────────────────

test('D-90..D-91 dashboard: “Couldn’t load your tabs” with Retry; “Grouping your tabs…” while the model works', async () => {
  await h.open([urlOf('ai-rag-pipeline')]);
  const p = await h.openPage('dashboard.html', (pg) => pg.addInitScript(`${FAULTS_SCRIPT}; window.__failState = true;`));
  const alert = p.getByRole('alert');
  await expect(alert).toContainText('Couldn’t load your tabs: Background unavailable');
  await p.evaluate(() => { (window as unknown as { __failState: boolean }).__failState = false; });
  await alert.getByRole('button', { name: 'Retry' }).click();
  await expect(alert).toHaveCount(0);
  await expect(p.getByRole('list', { name: 'All tabs' }).getByRole('listitem')).toHaveCount(1);
  // A refresh that fails later keeps the last list on screen.
  await p.evaluate(() => { (window as unknown as { __failState: boolean }).__failState = true; });
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(p.getByRole('alert')).toContainText('Couldn’t refresh (Background unavailable). Showing the last known tabs.');
  await expect(p.getByRole('list', { name: 'All tabs' }).getByRole('listitem')).toHaveCount(1);
  await p.evaluate(() => { const w = window as unknown as { __failState: boolean; __notReady: boolean }; w.__failState = false; w.__notReady = true; });
  await p.getByRole('alert').getByRole('button', { name: 'Retry' }).click();
  await expect(p.locator('.banner')).toContainText('Grouping your tabs…');
});
