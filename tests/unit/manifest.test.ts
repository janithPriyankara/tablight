import { describe, expect, it } from 'vitest';
import { manifest } from '../../manifest.config';
const CSP =
  "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self' https://www.wikidata.org https://en.wikipedia.org; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
describe('manifest', () => {
  it('requests exactly the minimal permissions', () => {
    expect([...manifest.permissions].sort()).toEqual([
      'alarms',
      'favicon',
      'offscreen',
      'sidePanel',
      'storage',
      'tabs',
      'unlimitedStorage',
    ]);
    expect(manifest.optional_permissions).toEqual(['tabGroups']);
  });
  it('has no host permissions or content scripts and blocks incognito', () => {
    const m = manifest as Record<string, unknown>;
    expect(m.host_permissions).toBeUndefined();
    expect(m.optional_host_permissions).toBeUndefined();
    expect('host_permissions' in m).toBe(false);
    expect('optional_host_permissions' in m).toBe(false);
    expect(m.content_scripts).toBeUndefined();
    expect(manifest.incognito).toBe('not_allowed');
  });
  it('takes its version from package.json (single source)', async () => {
    const pkg = (await import('../../package.json')).default as { version: string };
    expect(manifest.version).toBe(pkg.version);
  });
  it('uses the strict extension-page CSP', () => {
    expect(manifest.content_security_policy.extension_pages).toBe(CSP);
    // The opt-in look-up may reach Wikidata's API and its Wikipedia fallback, nothing else; no other directive changes.
    expect(manifest.content_security_policy.extension_pages).toBe(
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self' https://www.wikidata.org https://en.wikipedia.org; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(/connect-src ([^;]*)/.exec(manifest.content_security_policy.extension_pages)?.[1]).toBe("'self' https://www.wikidata.org https://en.wikipedia.org");
  });
  it('binds Alt+Shift+T to open the dashboard', () => {
    expect(manifest.commands['open-dashboard'].suggested_key.default).toBe('Alt+Shift+T');
  });
  it('binds Alt+P / Alt+Shift+P to add the current tab to Priority and remove it; 4 suggested keys at most', () => {
    expect(manifest.commands['prioritize-tab']).toEqual({ suggested_key: { default: 'Alt+P' }, description: 'Add the current tab to Priority' });
    expect(manifest.commands['unprioritize-tab']).toEqual({ suggested_key: { default: 'Alt+Shift+P' }, description: 'Remove the current tab from Priority' });
    expect(Object.values(manifest.commands).filter((c) => 'suggested_key' in c).length).toBeLessThanOrEqual(4);
  });
  it('declares the service worker, popup and no web-accessible resources', () => {
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
    expect(manifest.action.default_popup).toBe('popup.html');
    expect(manifest.web_accessible_resources).toEqual([]);
    expect(manifest.minimum_chrome_version).toBe('120');
  });
});
