export const CSP =
  "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const manifest = {
  manifest_version: 3,
  name: 'Tab Organizer',
  version: '0.1.0',
  description: 'Groups your tabs with an on-device model. Nothing leaves your device.',
  minimum_chrome_version: '120',
  incognito: 'not_allowed',
  permissions: ['tabs', 'storage', 'unlimitedStorage', 'alarms', 'offscreen', 'favicon'],
  optional_permissions: ['tabGroups'],
  background: { service_worker: 'background.js', type: 'module' },
  action: {
    default_popup: 'popup.html',
    default_title: 'Tab Organizer',
    default_icon: { '16': 'icons/16.png', '32': 'icons/32.png' },
  },
  icons: {
    '16': 'icons/16.png',
    '32': 'icons/32.png',
    '48': 'icons/48.png',
    '128': 'icons/128.png',
  },
  commands: {
    'open-dashboard': {
      suggested_key: { default: 'Alt+Shift+T' },
      description: 'Open the Tab Organizer dashboard',
    },
  },
  content_security_policy: { extension_pages: CSP },
  web_accessible_resources: [] as never[],
} as const;
