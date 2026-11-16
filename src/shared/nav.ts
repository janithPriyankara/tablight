/**
 * Focuses the dashboard tab if one is open (anywhere), else opens one. `hash` (without '#') selects a
 * view, e.g. "group=programming". Tabs are filtered by URL prefix: match patterns can't name
 * chrome-extension:// URLs, and the `tabs` permission already exposes every tab's URL.
 */
export async function openDashboard(hash = ''): Promise<void> {
  const base = chrome.runtime.getURL('dashboard.html');
  const url = hash ? `${base}#${hash}` : base;
  const existing = (await chrome.tabs.query({})).find((t) => t.url === base || t.url?.startsWith(`${base}#`));
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, hash ? { active: true, url } : { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}
