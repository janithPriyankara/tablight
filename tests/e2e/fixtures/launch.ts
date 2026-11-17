/**
 * Shared launch helpers for the e2e specs: start Chromium with only the built extension (dist/) loaded,
 * find its service worker and id, and talk to the background exactly as the UI does.
 */
import { chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Req } from '../../../src/shared/rpc';
import type { DashboardState } from '../../../src/shared/types';

export const DIST = resolve('dist');
export function assertBuilt(): void {
  if (!existsSync(join(DIST, 'manifest.json'))) {
    throw new Error('dist/manifest.json not found: run "npm run build" before the e2e tests.');
  }
}

export interface Launched {
  context: BrowserContext;
  sw: Worker;
  id: string;
}

/**
 * Launches Chromium (headless, full Chromium build: the headless shell cannot run extensions) with a
 * persistent profile in `dir` and only dist/ loaded, and waits for the extension's service worker.
 * `onContext` runs as soon as the browser is up (e.g. to attach request recorders before anything loads).
 */
export async function launchExtension(
  dir: string, extraArgs: string[] = [], onContext?: (c: BrowserContext) => void,
): Promise<Launched> {
  assertBuilt();
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, ...extraArgs],
  });
  onContext?.(context);
  try {
    const sw = context.serviceWorkers().find((w) => w.url().endsWith('/background.js'))
      ?? await context.waitForEvent('serviceworker', { predicate: (w) => w.url().endsWith('/background.js'), timeout: 30_000 });
    return { context, sw, id: new URL(sw.url()).host };
  } catch (e) {
    await context.close().catch(() => undefined); // never leave a half-launched Chromium behind
    throw e;
  }
}

/** Calls the background exactly as the UI does (same envelope, sent from an extension page). */
export async function rpc<T>(page: Page, req: Req): Promise<T> {
  const reply = await page.evaluate(
    (r) => chrome.runtime.sendMessage({ ...r, target: 'background' }) as Promise<{ ok: boolean; data?: unknown; error?: string }>,
    req,
  );
  if (!reply?.ok) throw new Error(`rpc ${req.t} failed: ${reply?.error ?? 'no reply'}`);
  return reply.data as T;
}
export const state = (page: Page): Promise<DashboardState> => rpc<DashboardState>(page, { t: 'state' });

export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const nav = (page: Page) => page.getByRole('navigation', { name: 'Views and groups' });
/** A sidebar entry by its name (its count, if any, follows the name). */
export const navButton = (page: Page, name: string) =>
  nav(page).getByRole('button', { name: new RegExp(`^${escapeRe(name)}(\\s|$)`) }).first();
