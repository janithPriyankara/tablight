/**
 * Boots the UI preview: a fake chrome.* (seeded with the preview tabs), then the REAL background code
 * running in this page, then the popup or dashboard. Only the browser API and the embedder are fake
 * (vite.preview.config.ts swaps the embedder). Every load starts from a fresh database.
 */
import { installChromeMock } from './chrome-mock';
import { addSuspiciousPreviewTabs, previewSeed } from './fixtures';
const REAL_DB = 'tab-organizer';
export async function startPreview(page: 'popup' | 'dashboard' | 'sidepanel'): Promise<void> {
  // A preview-specific database name, wiped on every load, so it never touches anything else.
  const dbName = `tab-organizer-preview-${page}`;
  const realOpen = indexedDB.open.bind(indexedDB);
  indexedDB.open = (name, version) => realOpen(name === REAL_DB ? dbName : name, version);
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  const control = installChromeMock(previewSeed());
  const c = control.chrome;
  // Preview server URLs: icons come from the server's placeholder at /_favicon/.
  c.runtime.getURL = (p) => `${location.origin}/${p.replace(/^\//, '')}`;
  // Messages reach every in-page listener (background handlers and UI) with a realistic sender.
  c.runtime.sendMessage = (message) => control.sendMessage(message, { id: c.runtime.id, url: location.href });
  const win = c.windows as unknown as Record<string, unknown>;
  win.getCurrent = async () => ({ id: control.windowIds()[0] });
  (c as unknown as { permissions: Record<string, unknown> }).permissions.request = async (p: { permissions?: string[] }) => {
    for (const x of p.permissions ?? []) control.setPermission(x, true);
    return true;
  };
  await import('../../background/index');
  control.fireInstalled('install');
  // A few tabs opened in the background after start-up, so the preview shows never-opened ("New") tabs.
  setTimeout(() => {
    const w = control.windowIds()[1] ?? control.windowIds()[0]!;
    for (const [url, title] of [
      ['https://www.youtube.com/watch?v=pv1&t=754s', 'Lecture 4: Attention and transformers - YouTube'],
      ['https://www.youtube.com/watch?v=pv2', 'The Making of Dune: Part Two - YouTube'],
      ['https://www.netflix.com/title/80057281', 'Watch Stranger Things | Netflix Official Site'],
    ] as const) control.addTab({ url, title, windowId: w, active: false, status: 'complete' });
    addSuspiciousPreviewTabs(control);
  }, 1500);
  const { render, createElement } = await import('preact');
  const root = document.getElementById('app')!;
  if (page === 'popup') render(createElement((await import('../popup/Popup')).Popup, null), root);
  else if (page === 'sidepanel') render(createElement((await import('../sidepanel/SidePanel')).SidePanel, null), root);
  else render(createElement((await import('../dashboard/Dashboard')).Dashboard, null), root);
  (globalThis as { __preview?: unknown }).__preview = control;
}
