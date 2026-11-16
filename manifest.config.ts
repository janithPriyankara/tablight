import { readFileSync } from 'node:fs';
/** package.json is the single source of the version; verify-release asserts the built manifest matches. */
export const VERSION: string = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;
export const CSP =
  "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const manifest = {
  manifest_version: 3,
  name: 'Tablight: Private AI Tab Organizer',
  short_name: 'Tablight',
  version: VERSION,
  description: 'Groups your tabs by topic with an AI model that runs on your device. No servers, no tracking.',
  minimum_chrome_version: '120',
  incognito: 'not_allowed',
  permissions: ['tabs', 'storage', 'unlimitedStorage', 'alarms', 'offscreen', 'favicon', 'sidePanel'],
  optional_permissions: ['tabGroups'],
  background: { service_worker: 'background.js', type: 'module' },
  action: {
    default_popup: 'popup.html',
    default_title: 'Tablight',
    default_icon: { '16': 'icons/16.png', '32': 'icons/32.png' },
  },
  side_panel: { default_path: 'sidepanel.html' },
  icons: {
    '16': 'icons/16.png',
    '32': 'icons/32.png',
    '48': 'icons/48.png',
    '128': 'icons/128.png',
  },
  commands: {
    'open-dashboard': {
      suggested_key: { default: 'Alt+Shift+T' },
      description: 'Open the Tablight dashboard',
    },
    'open-side-panel': {
      suggested_key: { default: 'Alt+Shift+S' },
      description: 'Open Tablight in the side panel',
    },
  },
  content_security_policy: { extension_pages: CSP },
  web_accessible_resources: [] as never[],
} as const;
