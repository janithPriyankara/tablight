/**
 * Shared harness for the UI specs (tests/e2e/ui-*.spec.ts): one Chromium per spec file with the built extension,
 * the local page server, and a `reset()` that puts the extension back to a known state between tests without
 * relaunching (the model warm-up is the slow part of a launch).
 *
 * reset(): only the dashboard tab is left open, "Delete all data" wipes everything the extension stored (stash,
 * user groups, sessions, settings, dismissed suggestions, pending undos, the synced copy) and re-seeds the starter
 * groups, the pages' localStorage (hints, side panel sections) is cleared, then the given settings are applied
 * (onboarded on by default, so the welcome card is only there in the tests that ask for it).
 */
import { expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DashboardState, Item, Settings } from '../../../src/shared/types';
import { assertBuilt, launchExtension, navButton, rpc, state } from './launch';
import { startPageServer, type PageServer } from './server';

/** First model load in a fresh profile; classification of a handful of tabs is far quicker. */
export const SETTLE_MS = 120_000;

export interface TabInfo {
  id: number; url: string; title: string; active: boolean; windowId: number; discarded: boolean;
  groupId: number; badge: string;
}

export class Harness {
  private constructor(
    readonly context: BrowserContext,
    readonly sw: Worker,
    readonly extId: string,
    readonly server: PageServer,
    private readonly dir: string,
    public dash: Page,
  ) {}
  /** Whether the fresh install opened the dashboard tab by itself (see start()). */
  installTabOpened = false;

  /** Launches Chromium with dist/ and opens the dashboard once the starter groups exist. */
  static async start(extraArgs: string[] = []): Promise<Harness> {
    assertBuilt();
    const server = await startPageServer();
    const dir = mkdtempSync(join(tmpdir(), 'tablight-e2e-ui-'));
    try {
      const { context, sw, id } = await launchExtension(dir, extraArgs);
      // A fresh install opens the dashboard by itself: that tab becomes the harness's dashboard.
      const isDash = (url: string) => url === `chrome-extension://${id}/dashboard.html`;
      let installed = context.pages().find((p) => isDash(p.url()));
      installed ??= await context.waitForEvent('page', { predicate: (p) => isDash(p.url()), timeout: 30_000 }).catch(() => undefined);
      const dash = installed ?? await context.newPage();
      const h = new Harness(context, sw, id, server, dir, dash);
      h.installTabOpened = installed !== undefined;
      if (!installed) await dash.goto(h.ext('dashboard.html'));
      await expect.poll(async () => (await state(dash)).groups.length, { timeout: SETTLE_MS }).toBeGreaterThan(0);
      return h;
    } catch (e) {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.server.close();
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** chrome-extension://<id>/<path> */
  ext(path: string): string {
    return `chrome-extension://${this.extId}/${path}`;
  }
  dashUrl(hash = ''): string {
    return this.ext(`dashboard.html${hash ? `#${hash}` : ''}`);
  }
  /** A local test page by slug (http://127.0.0.1:<port>/p/<slug>). */
  url(slug: string, query?: string): string {
    return this.server.url(slug, query);
  }

  /** Back to a known state; see the file comment. Leaves the dashboard (All tabs) in front. */
  async reset(settings: Partial<Settings> = {}): Promise<void> {
    if (this.dash.isClosed()) this.dash = await this.context.newPage();
    for (const p of this.context.pages()) if (p !== this.dash) await p.close().catch(() => undefined);
    await this.dash.goto(this.dashUrl());
    await this.dash.bringToFront();
    const keep = await this.dash.evaluate(() => chrome.tabs.getCurrent().then((t) => t!.id!));
    await this.dash.evaluate(async (me) => {
      const tabs = await chrome.tabs.query({});
      await Promise.all(tabs.filter((t) => t.id !== me).map((t) => chrome.tabs.remove(t.id!).catch(() => undefined)));
    }, keep);
    await expect.poll(async () => (await this.tabs()).length).toBe(1);
    await rpc(this.dash, { t: 'deleteAllData' });
    await this.dash.evaluate(async () => {
      localStorage.clear();
      await chrome.storage.session.remove('lastSession');
    });
    await rpc(this.dash, { t: 'settings', patch: { onboarded: true, ...settings } });
    await expect.poll(async () => {
      const s = await state(this.dash);
      return s.groups.length > 0 && s.items.length === 0 && s.queued === 0;
    }, { timeout: SETTLE_MS }).toBe(true);
    await this.dash.reload();
    await expect(this.dash.getByRole('heading', { level: 1 })).toHaveText('All tabs');
  }

  state(page: Page = this.dash): Promise<DashboardState> {
    return state(page);
  }

  /** Every tab with its toolbar badge text, read through the extension's own APIs. */
  tabs(): Promise<TabInfo[]> {
    return this.dash.evaluate(async () => {
      const all = await chrome.tabs.query({});
      // A tab can close between the query and its badge read (e.g. while a window is being saved);
      // leave it out instead of failing the whole read.
      const rows = await Promise.all(all.map(async (t) => {
        const badge = await chrome.action.getBadgeText({ tabId: t.id! }).catch(() => null);
        return badge === null ? null : {
          id: t.id!, url: t.url || t.pendingUrl || '', title: t.title ?? '', active: t.active, windowId: t.windowId,
          discarded: t.discarded, groupId: t.groupId ?? -1, badge,
        };
      }));
      return rows.filter((r) => r !== null);
    });
  }
  async tabsAt(url: string): Promise<TabInfo[]> {
    return (await this.tabs()).filter((t) => t.url === url);
  }

  /**
   * Opens each URL in a background tab (never viewed, so it counts as "New"), in `windowId` or the dashboard's
   * window, and waits until all are indexed under their real titles and classified.
   */
  async open(urls: string[], opts: { windowId?: number; settle?: boolean } = {}): Promise<void> {
    await this.dash.evaluate(async ({ urls, windowId }) => {
      for (const url of urls) await chrome.tabs.create({ url, active: false, ...(windowId !== undefined ? { windowId } : {}) });
    }, { urls, windowId: opts.windowId });
    if (opts.settle !== false) await this.settle(urls);
  }
  /** Opens a new (unfocused) window with these URLs; returns its id once they are indexed and classified. */
  async openWindow(urls: string[]): Promise<number> {
    const id = await this.dash.evaluate((u) => chrome.windows.create({ url: u, focused: false }).then((w) => w!.id!), urls);
    await this.settle(urls);
    return id;
  }
  /** Waits until a tab of every URL is indexed with its real title and nothing waits for classification. */
  async settle(urls: string[]): Promise<DashboardState> {
    let last: DashboardState | undefined;
    await expect.poll(async () => {
      last = await state(this.dash);
      const ok = urls.every((u) => last!.items.some((i) => i.url === u && i.tabId !== undefined && i.title !== '' &&
        !i.title.startsWith('http') && i.embKey !== undefined));
      return ok && last.queued === 0;
    }, { timeout: SETTLE_MS }).toBe(true);
    return last!;
  }
  /** The item of an open tab (or, with `stashed`, the saved record) for a URL. */
  async item(url: string, stashed = false): Promise<Item> {
    const s = await state(this.dash);
    const i = s.items.find((x) => x.url === url && (stashed ? x.state === 'stashed' : x.state !== 'stashed'));
    if (!i) throw new Error(`no ${stashed ? 'saved' : 'open'} item for ${url}`);
    return i;
  }
  async groupName(id: string | null): Promise<string | undefined> {
    return id === null ? undefined : (await state(this.dash)).groups.find((g) => g.id === id)?.name;
  }

  /** Opens an extension page (popup.html, sidepanel.html…) as a tab in the dashboard's window. */
  async openPage(path: string, init?: (p: Page) => Promise<unknown>): Promise<Page> {
    const p = await this.context.newPage();
    if (init) await init(p);
    await p.goto(this.ext(path));
    return p;
  }

  /** Waits for a page (any tab) whose URL satisfies `test`. */
  async pageWhere(test: (url: string) => boolean): Promise<Page> {
    let found: Page | undefined;
    await expect.poll(() => {
      found = this.context.pages().find((p) => !p.isClosed() && test(p.url()));
      return found !== undefined;
    }).toBe(true);
    return found!;
  }

  /** Imports a backup (as a JSON value) through Settings → Import, the way a user picks a file. */
  async importBackup(json: unknown, name = 'backup.json'): Promise<void> {
    await navButton(this.dash, 'Settings').click();
    await this.dash.getByLabel('Import backup file').setInputFiles({
      name, mimeType: 'application/json', buffer: Buffer.from(typeof json === 'string' ? json : JSON.stringify(json)),
    });
  }
}

/** A Tablight backup file (format of src/io/import-export.ts) with these saved tabs, groups and sessions. */
export function backup(opts: {
  items?: { url: string; title: string; group?: string }[];
  groups?: string[];
  snapshots?: { takenAt: number; windows: { url: string; title: string }[][] }[];
}): unknown {
  return {
    format: 'tab-organizer', version: 1, exportedAt: Date.now(),
    groups: (opts.groups ?? []).map((name) => ({ name, color: '#4284c5', icon: null })),
    items: (opts.items ?? []).map((i, n) => ({ url: i.url, title: i.title, groupName: i.group ?? null, stashedAt: Date.now() - n * 1000 })),
    snapshots: (opts.snapshots ?? []).map((s) => ({ takenAt: s.takenAt, windows: s.windows.map((tabs) => ({ tabs })) })),
  };
}

/**
 * Init script for an extension page: lets a test make the page's `state` reads fail (window.__failState = true)
 * or report the model as still loading (window.__notReady = true), to show the error and "Organizing" states.
 * Everything else still talks to the real background.
 */
export const FAULTS_SCRIPT = `(() => {
  const rt = chrome.runtime;
  const orig = rt.sendMessage.bind(rt);
  const wrapped = (msg, ...rest) => {
    if (msg && msg.t === 'state' && window.__failState) return Promise.reject(new Error('Background unavailable'));
    const p = orig(msg, ...rest);
    if (!(msg && msg.t === 'state' && window.__notReady)) return p;
    return p.then((r) => (r && r.ok ? { ...r, data: { ...r.data, modelReady: false } } : r));
  };
  try { rt.sendMessage = wrapped; } catch { /* read-only */ }
  if (rt.sendMessage !== wrapped) Object.defineProperty(rt, 'sendMessage', { value: wrapped, configurable: true, writable: true });
})();`;
