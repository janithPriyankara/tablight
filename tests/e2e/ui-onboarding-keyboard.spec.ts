/**
 * First run (welcome card), the guided tour, keyboard use and basic accessibility, end to end, in the BUILT
 * extension (dist/). Run `npm run build` first. IDs (O-…, T-…, K-…, A-…) are rows of docs/testing/ui-test-cases.md.
 */
import { expect, test, type Page } from '@playwright/test';
import { TOUR_STEPS } from '../../src/ui/dashboard/Tour';
import { navButton, rpc } from './fixtures/launch';
import { PAGES } from './fixtures/server';
import { Harness } from './fixtures/ui';

let h: Harness;
/** What the fresh install did on its own, before any test ran. */
let installTab: { opened: boolean; welcome: boolean } = { opened: false, welcome: false };
// Every test resets its own state (beforeEach), so a failure does not skip the tests after it.
test.use({ actionTimeout: 20_000 });
test.beforeAll(async () => {
  h = await Harness.start();
  // Before any reset: the tab the install opened, and its welcome card.
  installTab = {
    opened: h.installTabOpened,
    welcome: await h.dash.getByRole('region', { name: 'Welcome to Tablight' }).waitFor({ timeout: 30_000 }).then(() => true, () => false),
  };
});
test.afterAll(async () => {
  await h?.close();
});
test.beforeEach(async () => {
  await h.reset(test.info().title.startsWith('O-') ? { onboarded: false } : {});
  await h.dash.setViewportSize({ width: 1280, height: 900 });
});

const page = () => h.dash;
const heading = () => page().getByRole('heading', { level: 1 });
const toast = () => page().locator('.toast');
const welcome = () => page().getByRole('region', { name: 'Welcome to Tablight' });
const card = () => page().locator('.tour-card');

// ── onboarding ──────────────────────────────────────────────────────────────────────────────────────────

test('O-01..O-04 first run: the install opens the dashboard with the welcome card; Take the tour, Auto-pause, Got it', async () => {
  await test.step('O-01 a fresh install opens the dashboard by itself, with the welcome card', async () => {
    expect(installTab).toEqual({ opened: true, welcome: true });
  });
  // O-01 only reads what the install did; the reset before this test (onboarded: false) still holds.
  await test.step('O-02..O-04 welcome card: “Take the tour”, “Auto-pause … 1 hour”, then the privacy points and “Got it” for good', async () => {
    // One onboarded:false journey; between steps the welcome card is brought back the way a fresh profile has it.
    const unboard = async () => {
      await rpc(page(), { t: 'settings', patch: { onboarded: false } });
      await page().goto(h.dashUrl());
      await expect(welcome()).toBeVisible();
    };
    await test.step('O-04 welcome card: “Take the tour” starts the tour; ending it counts as done', async () => {
      await welcome().getByRole('button', { name: 'Take the tour' }).click();
      await expect(card()).toContainText('1 of 13');
      await card().getByRole('button', { name: 'Skip tour' }).click();
      await expect(card()).toHaveCount(0);
      await expect.poll(async () => (await h.state()).settings.onboarded).toBe(true);
      await expect(welcome()).toHaveCount(0);
    });
    await test.step('O-03 welcome card: “Auto-pause tabs unused for 1 hour” turns auto-pause on and closes the card', async () => {
      await unboard();
      await welcome().getByRole('button', { name: 'Auto-pause tabs unused for 1 hour' }).click();
      await expect(toast()).toContainText('Auto-pause is on: tabs unused for an hour will pause');
      await expect(welcome()).toHaveCount(0);
      await navButton(page(), 'Settings').click();
      await expect(page().getByRole('combobox', { name: /Auto-pause tabs/ })).toHaveValue('60');
    });
    await test.step('O-02 welcome card: three privacy points and the pin hint; “Got it” hides it for good', async () => {
      await unboard();
      await expect(welcome()).toBeVisible();
      const points = welcome().getByRole('listitem');
      await expect(points).toHaveCount(4); // three points plus "Pin Tablight" (the icon is not pinned in a new profile)
      await expect(points.last()).toContainText('Pin Tablight');
      await welcome().getByRole('button', { name: 'Got it' }).click();
      await expect(welcome()).toHaveCount(0);
      await expect.poll(async () => (await h.state()).settings.onboarded).toBe(true);
      await page().reload();
      await expect(heading()).toHaveText('All tabs');
      await expect(welcome()).toHaveCount(0);
    });
  });
});

// ── guided tour ─────────────────────────────────────────────────────────────────────────────────────────

test('T-01..T-04 guided tour: every step, keys and focus trap, from Settings, in a narrow window', async () => {
  // Journey: each part starts from a reset, so it checks exactly what its old test did.
  await test.step('T-01..T-03 tour: every step with Next/Back and its spotlight, Done returns focus; arrow keys and the focus trap; Settings → “Start the tour”', async () => {
    await test.step('T-01 tour: every step in order with Next and Back, the spotlight on what it explains, Done returns focus', async () => {
      await h.open([h.url(PAGES[0]!.slug)]);
      await navButton(page(), 'Saved for later').click(); // the tour switches to All tabs itself
      const start = page().getByRole('button', { name: 'Guided tour' });
      await start.click();
      await expect(heading()).toHaveText('All tabs');
      const n = TOUR_STEPS.length;
      await expect(card().getByRole('button', { name: 'Back' })).toBeDisabled();
      for (let i = 0; i < n; i++) {
        const step = TOUR_STEPS[i]!;
        await expect(card().locator('.tour-step')).toHaveText(`${i + 1} of ${n}`);
        await expect(card().getByRole('heading')).toHaveText(step.title);
        await expect(card()).toHaveAttribute('role', 'dialog');
        // A step about something on the page lights it up; the others dim the page and centre the card.
        await expect(page().locator(step.target ? '.tour-spot' : '.tour-dim')).toHaveCount(1);
        if (step.target) {
          // The spotlight glides to its target (a short transition): poll until it surrounds it, 4 px on each side.
          await expect.poll(async () => {
            const spot = (await page().locator('.tour-spot').boundingBox())!;
            const t = (await page().locator(step.target!).first().boundingBox())!;
            return [spot.x + 4 - t.x, spot.y + 4 - t.y, spot.width - 8 - t.width, spot.height - 8 - t.height].every((d) => Math.abs(d) < 2);
          }, { message: step.title }).toBe(true);
        }
        if (i === 1) { // Back goes one step back.
          await card().getByRole('button', { name: 'Back' }).click();
          await expect(card().locator('.tour-step')).toHaveText(`1 of ${n}`);
          await card().getByRole('button', { name: 'Next' }).click();
        }
        if (i < n - 1) await card().getByRole('button', { name: 'Next' }).click();
      }
      await expect(card().getByRole('button', { name: 'Close' })).toBeVisible();
      await card().getByRole('button', { name: 'Done' }).click();
      await expect(card()).toHaveCount(0);
      await expect(start).toBeFocused();
    });
    await test.step('T-02 tour keys: → and ← move, Tab stays inside the card, Esc ends it', async () => {
      await page().getByRole('button', { name: 'Guided tour' }).click();
      await expect(card()).toBeFocused();
      await page().keyboard.press('ArrowRight');
      await page().keyboard.press('ArrowRight');
      await expect(card().locator('.tour-step')).toHaveText(`3 of ${TOUR_STEPS.length}`);
      await page().keyboard.press('ArrowLeft');
      await expect(card().locator('.tour-step')).toHaveText(`2 of ${TOUR_STEPS.length}`);
      // Focus cycles Skip → Back → Next → Skip.
      const focused = () => page().evaluate(() => document.activeElement?.textContent ?? '');
      await page().keyboard.press('Tab');
      const seen = [await focused()];
      for (let k = 0; k < 3; k++) {
        await page().keyboard.press('Tab');
        seen.push(await focused());
      }
      expect(seen).toEqual(['Skip tour', 'Back', 'Next', 'Skip tour']);
      await page().keyboard.press('Shift+Tab');
      expect(await focused()).toBe('Next');
      await page().keyboard.press('Escape');
      await expect(card()).toHaveCount(0);
    });
    await test.step('T-03 Settings → “Start the tour” goes to All tabs and starts it', async () => {
      await navButton(page(), 'Settings').click();
      await page().getByRole('button', { name: 'Start the tour' }).click();
      await expect(heading()).toHaveText('All tabs');
      await expect(card().getByRole('heading')).toHaveText(TOUR_STEPS[0]!.title);
    });
  });
  await h.reset(); await h.dash.setViewportSize({ width: 1280, height: 900 }); // a clean slate, as when this part was its own test
  await test.step('T-04 tour in a narrow window: steps about the hidden sidebar show a centred card instead', async () => {
    await page().setViewportSize({ width: 800, height: 800 });
    await page().getByRole('button', { name: 'Guided tour' }).click();
    await page().keyboard.press('ArrowRight'); // "Your groups": the sidebar is hidden below 900 px
    await expect(card().getByRole('heading')).toHaveText(TOUR_STEPS[1]!.title);
    await expect(page().locator('.tour-dim')).toHaveCount(1);
    await expect(page().locator('.tour-spot')).toHaveCount(0);
    const box = (await card().boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(800);
    await page().keyboard.press('Escape');
  });
});

// ── keyboard ────────────────────────────────────────────────────────────────────────────────────────────

test('K-01..K-04, A-01 keyboard and accessibility: search and list keys, dialogs, narrow window View menu, every control named', async () => {
  await test.step('K-01..K-02 “/” jumps to search, ↓ to the list; list keys move, select, clear, Delete closes, Enter switches to the real tab', async () => {
    const urls = [0, 15, 30, 40].map((n) => h.url(PAGES[n]!.slug));
    await h.open(urls);
    await test.step('K-02 list keys: ↓ ↑ Home End move; Space and Shift+↓ select; Esc clears; Delete closes; Enter switches to the tab', async () => {
      const row = (i: number) => page().locator(`.grid-row[data-index="${i}"] .item-main`);
      const bar = page().getByRole('toolbar', { name: 'Selected tabs' });
      await row(0).focus();
      await page().keyboard.press('ArrowDown');
      await expect(row(1)).toBeFocused();
      await page().keyboard.press('End');
      await expect(row(3)).toBeFocused();
      await page().keyboard.press('ArrowUp');
      await expect(row(2)).toBeFocused();
      await page().keyboard.press('Home');
      await expect(row(0)).toBeFocused();
      await page().keyboard.press('Space');
      await expect(bar).toContainText('1 selected');
      await page().keyboard.press('Shift+ArrowDown');
      await page().keyboard.press('Shift+ArrowDown');
      await expect(bar).toContainText('3 selected');
      await page().keyboard.press('Escape');
      await expect(bar).toHaveCount(0);
      // Delete closes the focused tab (nothing selected), with Undo.
      const title = (await row(2).locator('.item-title').innerText());
      await row(2).focus();
      await page().keyboard.press('Delete');
      await expect(toast()).toContainText('Closed 1 tab');
      await expect(page().locator('.grid-row').filter({ hasText: title })).toHaveCount(0);
      // Enter switches to the focused row's tab.
      const target = await row(0).locator('.item-title').innerText();
      await row(0).focus();
      await page().keyboard.press('Enter');
      await expect.poll(async () => (await h.tabs()).find((t) => t.active && t.windowId !== undefined && t.title === target) !== undefined).toBe(true);
    });
    await test.step('K-01 “/” jumps to search from anywhere but a text field; ↓ goes from search to the list', async () => {
      await page().bringToFront(); // Enter (K-02) switched to another tab
      const box = page().getByRole('searchbox', { name: 'Search tabs' });
      await page().locator('body').click({ position: { x: 600, y: 400 } });
      await page().keyboard.press('/');
      await expect(box).toBeFocused();
      await expect(box).toHaveValue(''); // the "/" is not typed
      await page().keyboard.type('a/b');
      await expect(box).toHaveValue('a/b'); // inside the field, "/" is just a character
      await box.fill('');
      await page().keyboard.press('ArrowDown');
      await expect(page().locator('.grid-row[data-index="0"] .item-main')).toBeFocused();
    });
  });
  await h.reset(); await h.dash.setViewportSize({ width: 1280, height: 900 }); // a clean slate, as when this part was its own test
  await test.step('K-03 dialogs: focus starts on Cancel for a risky action, Tab stays inside, Esc and the backdrop close, focus comes back', async () => {
    await navButton(page(), 'Other').click();
    await page().getByRole('button', { name: 'Rename group' }).click();
    let d = page().getByRole('dialog', { name: 'Rename Other' });
    await expect(d.getByRole('textbox', { name: 'Name' })).toBeFocused();
    await page().keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    await expect(page().getByRole('button', { name: 'Rename group' })).toBeFocused();
    // A risky one: Merge is not, Delete All Data is. Use Settings → Delete all data.
    await navButton(page(), 'Settings').click();
    const del = page().getByRole('button', { name: 'Delete all data' });
    await del.click();
    d = page().getByRole('dialog', { name: 'Delete all data?' });
    const cancel = d.getByRole('button', { name: 'Cancel' });
    const confirm = d.getByRole('button', { name: 'Delete all data' });
    await expect(cancel).toBeFocused();
    await page().keyboard.press('Tab');
    await expect(confirm).toBeFocused();
    await page().keyboard.press('Tab');
    await expect(cancel).toBeFocused();
    await page().keyboard.press('Shift+Tab');
    await expect(confirm).toBeFocused();
    // The page behind is inert while the dialog is open.
    expect(await page().locator('.dash').getAttribute('inert')).not.toBeNull();
    await page().mouse.click(5, 5); // the backdrop
    await expect(d).toHaveCount(0);
    await expect(del).toBeFocused();
    expect(await page().locator('.dash').getAttribute('inert')).toBeNull();
  });
  await h.reset(); await h.dash.setViewportSize({ width: 1280, height: 900 }); // a clean slate, as when this part was its own test
  await test.step('K-04 narrow window: the sidebar becomes a “View” menu that switches views and groups', async () => {
    await h.open([h.url(PAGES[0]!.slug)]);
    await page().setViewportSize({ width: 800, height: 800 });
    await expect(page().getByRole('navigation', { name: 'Views and groups' })).toBeHidden();
    const menu = page().getByRole('combobox', { name: 'View' });
    await expect(menu).toBeVisible();
    await menu.selectOption({ label: 'Saved for later' });
    await expect(heading()).toHaveText('Saved for later');
    const s = await h.state();
    const g = s.groups.find((x) => x.id === s.items[0]!.groupId)!;
    await menu.selectOption({ label: `${g.name} (${g.count})` });
    await expect(heading()).toHaveText(g.name);
    expect(page().url()).toBe(h.dashUrl(`group=${encodeURIComponent(g.id)}`));
  });
  await h.reset(); await h.dash.setViewportSize({ width: 1280, height: 900 }); // a clean slate, as when this part was its own test
  await test.step('A-01 every button, link and field has a name, on every dashboard view, the popup and the side panel', async () => {
    const u = h.url(PAGES[0]!.slug);
    await h.open([u, u, h.url(PAGES[15]!.slug)]);
    for (const name of ['All tabs', 'Unsorted', 'Duplicates', 'Saved for later', 'Sessions', 'Settings']) {
      await navButton(page(), name).click();
      await expect(heading()).toHaveText(name);
      expect(await unnamed(page()), name).toEqual([]);
    }
    await navButton(page(), 'All tabs').click();
    await page().locator('.grid-row[data-index="0"] .row-check').check();
    expect(await unnamed(page()), 'with the selection bar').toEqual([]);
    for (const path of ['popup.html', 'sidepanel.html']) {
      const p = await h.openPage(path);
      await expect(p.locator('.totals')).toBeVisible();
      expect(await unnamed(p), path).toEqual([]);
      await p.close();
    }
  });
});

// ── accessibility ───────────────────────────────────────────────────────────────────────────────────────

/** Buttons, links and form fields with no accessible name (aria-label, aria-labelledby, label or text). */
function unnamed(p: Page): Promise<string[]> {
  return p.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [role="button"]')) {
      if (el.closest('[hidden]') || (el as HTMLInputElement).type === 'hidden') continue;
      const name = el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') ?? '').split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '').join('').trim() ||
        ((el as HTMLInputElement).labels?.[0]?.textContent ?? '').trim() || (el.textContent ?? '').trim() || el.getAttribute('title');
      if (!name) out.push(el.outerHTML.slice(0, 120));
    }
    return out;
  });
}
