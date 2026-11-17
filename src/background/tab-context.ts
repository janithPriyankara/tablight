import type { TabContext } from '../shared/clues';
import { domainOf } from '../shared/url';
/**
 * Per-tab context for the suspicious-tab clues, kept in chrome.storage.session only (never persisted,
 * never sent anywhere). Best-effort: every chrome.* failure is swallowed.
 */
const OPENERS = 'suspOpeners';
const POPUP_WINDOWS = 'suspPopupWindows';
const KEPT = 'suspKept';
type Rec<V> = Record<string, V>;
// Read-modify-write on session storage races when many tabs open at once, so all writes run one at a time.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}
async function read<V>(key: string): Promise<Rec<V>> {
  try {
    const got = await chrome.storage.session.get(key);
    return (got[key] as Rec<V> | undefined) ?? {};
  } catch {
    return {};
  }
}
async function write(key: string, value: unknown): Promise<void> {
  try {
    await chrome.storage.session.set({ [key]: value });
  } catch {
    // best effort
  }
}
async function update<V>(key: string, fn: (rec: Rec<V>) => void): Promise<void> {
  await serial(async () => {
    const rec = await read<V>(key);
    fn(rec);
    await write(key, rec);
  });
}
export async function recordCreated(tab: chrome.tabs.Tab): Promise<void> {
  const id = tab.id;
  if (id === undefined || tab.openerTabId === undefined) return;
  let domain = '';
  try {
    const opener = await chrome.tabs.get(tab.openerTabId);
    domain = opener.url ? domainOf(opener.url) : '';
  } catch {
    return;
  }
  if (!domain) return;
  await update<string>(OPENERS, (r) => {
    r[String(id)] = domain;
  });
}
export async function loadContexts(
  tabs: { tabId: number; windowId?: number }[],
): Promise<Map<number, TabContext>> {
  const openers = await read<string>(OPENERS);
  const cache = await read<boolean>(POPUP_WINDOWS);
  const fresh: Rec<boolean> = {};
  const missing = [...new Set(tabs.map((t) => t.windowId))].filter(
    (w): w is number => w !== undefined && cache[String(w)] === undefined,
  );
  const results = await Promise.all(
    missing.map(async (w): Promise<[number, boolean | undefined]> => {
      try {
        const win = await chrome.windows.get(w);
        return [w, win.type === 'popup'];
      } catch {
        return [w, undefined]; // failed lookups count as false and are not cached
      }
    }),
  );
  for (const [w, v] of results) if (v !== undefined) fresh[String(w)] = v;
  if (Object.keys(fresh).length) {
    await update<boolean>(POPUP_WINDOWS, (r) => Object.assign(r, fresh));
  }
  const popups = { ...cache, ...fresh };
  const out = new Map<number, TabContext>();
  for (const t of tabs) {
    out.set(t.tabId, {
      openerDomain: openers[String(t.tabId)],
      popup: t.windowId !== undefined && popups[String(t.windowId)] === true,
    });
  }
  return out;
}
export async function keepTab(tabId: number, domain: string): Promise<void> {
  await update<string>(KEPT, (r) => {
    r[String(tabId)] = domain;
  });
}
export async function loadKept(): Promise<Map<number, string>> {
  const rec = await read<string>(KEPT);
  return new Map(Object.entries(rec).map(([k, v]) => [Number(k), v]));
}
/**
 * Ends the keep of every listed tab that is now on another site (a keep lasts until the tab closes or its
 * domain changes, so coming back later does not restore it). Unlisted tabs are left alone. Returns what
 * stays kept.
 */
export async function pruneKept(tabs: { tabId: number; domain: string }[]): Promise<Map<number, string>> {
  const current = await loadKept();
  const stale = tabs.filter((t) => current.has(t.tabId) && current.get(t.tabId) !== t.domain).map((t) => String(t.tabId));
  if (!stale.length) return current;
  let out = current;
  await update<string>(KEPT, (r) => {
    for (const id of stale) delete r[id];
    out = new Map(Object.entries(r).map(([k, v]) => [Number(k), v]));
  });
  return out;
}
export async function forgetTab(tabId: number): Promise<void> {
  await update<string>(OPENERS, (r) => {
    delete r[String(tabId)];
  });
  await update<string>(KEPT, (r) => {
    delete r[String(tabId)];
  });
}
