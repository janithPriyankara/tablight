import { useRef } from 'preact/hooks';
import { send } from '../../shared/rpc';
import type { Settings as SettingsT, SyncStatus } from '../../shared/types';
import { ago, plural } from '../common/format';
import { DownloadIcon, ShieldIcon, TrashIcon, UploadIcon } from '../common/icons';
import { isoDate, syncStatusLine } from './views';

/** Same limit the background's import enforces; checked before the file is read. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const AUTO_SLEEP_CHOICES: { value: number | null; label: string }[] = [
  { value: null, label: 'Off' }, { value: 15, label: '15 minutes' }, { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' }, { value: 120, label: '2 hours' }, { value: 240, label: '4 hours' },
  { value: 480, label: '8 hours' }, { value: 1440, label: '1 day' },
];
/** The installed version (empty outside the extension, e.g. in tests). */
const VERSION = (typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.().version) || '';
const ABOUT_LINKS: [string, string][] = [
  ['about.html', 'About Tablight'], ['support.html', 'Help and support'], ['privacy.html', 'Privacy policy'],
  ['terms.html', 'Terms of use'], ['licenses.html', 'Open-source licences'],
];
const TOOLBAR: { value: SettingsT['toolbarOpens']; label: string }[] = [
  { value: 'popup', label: 'Popup' }, { value: 'sidepanel', label: 'Side panel' },
];
const THEMES: { value: SettingsT['theme']; label: string }[] = [
  { value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' },
];

/** Saves a backup: the JSON from the `export` RPC as a download (Blob + a[download], no downloads permission). */
export async function exportBackup(): Promise<void> {
  const json = await send<string>({ t: 'export' });
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `tablight-${isoDate()}.json`;
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    // Revoke after the click has been handled (the download keeps its own reference).
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Reads a backup file and imports it; files over 20 MB are refused before reading. */
export interface ImportResult { added: number; skipped: number; skippedSessions?: number }
export async function importBackup(file: File): Promise<ImportResult> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('That file is larger than 20 MB, so it can’t be a Tablight backup.');
  const json = await file.text();
  return send<ImportResult>({ t: 'import', json });
}
/** "Imported 3 tabs · skipped 1 · 2 sessions not imported (the 14 saved sessions are full)". */
export function importNotice(r: ImportResult): string {
  return [
    `Imported ${plural(r.added, 'tab')}`,
    r.skipped ? `skipped ${r.skipped}` : '',
    r.skippedSessions ? `${plural(r.skippedSessions, 'session')} not imported (saved sessions are full)` : '',
  ].filter(Boolean).join(' · ');
}

export interface SettingsProps {
  settings: SettingsT;
  syncStatus: SyncStatus;
  busy: boolean;
  save: (patch: Partial<SettingsT>) => Promise<void>;
  /** Runs an action with the dashboard's busy guard, error reporting and refresh. */
  act: (fn: () => Promise<void>) => Promise<void>;
  notify: (message: string) => void;
  /** Settings → Delete all data (the dashboard confirms first). */
  onDeleteAll: () => void;
  /** Starts the guided tour. */
  onTour?: () => void;
}

export function Settings({ settings, syncStatus, busy, save, act, notify, onDeleteAll, onTour }: SettingsProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const autoValue = settings.autoSleepMinutes === null ? 'off' : String(settings.autoSleepMinutes);
  const choices = AUTO_SLEEP_CHOICES.some((c) => c.value === settings.autoSleepMinutes)
    ? AUTO_SLEEP_CHOICES
    : [...AUTO_SLEEP_CHOICES, { value: settings.autoSleepMinutes, label: plural(settings.autoSleepMinutes ?? 0, 'minute') }];

  /** The permission prompt needs the click's user gesture: request it first, before anything awaits. */
  const onMirror = (on: boolean) => {
    if (!on) return void act(() => save({ mirrorTabGroups: false }));
    const asked = chrome.permissions.request({ permissions: ['tabGroups'] });
    void act(async () => {
      const granted = await asked.catch(() => false);
      if (!granted) return notify('Permission not granted, so tab groups are not mirrored.');
      await save({ mirrorTabGroups: true });
    });
  };
  const onImport = (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = ''; // the same file can be picked again
    if (!file) return;
    void act(async () => {
      const r = await importBackup(file);
      notify(importNotice(r));
    });
  };

  return (
    <div class="page-scroll">
      <form class="settings" onSubmit={(e) => e.preventDefault()}>
        {onTour && (
          <section class="settings-group" aria-labelledby="set-help-h">
            <h2 class="settings-h" id="set-help-h">Help</h2>
            <div class="setting">
              <span class="setting-text">
                <span class="setting-name">Guided tour</span>
                <span class="setting-help">A short walk through every part of Tablight, using your own tabs.</span>
              </span>
              <button type="button" class="btn btn-sm" onClick={onTour}>Start the tour</button>
            </div>
          </section>
        )}
        <section class="settings-group" aria-labelledby="set-grouping-h">
          <h2 class="settings-h" id="set-grouping-h">Grouping</h2>
          <label class="setting">
            <span class="setting-text">
              <span class="setting-name">Create new groups automatically</span>
              <span class="setting-help">
                When 3 or more unsorted tabs share a topic, make a group for them right away instead of suggesting
                one. You can rename or delete it; a deleted group doesn’t come back.
              </span>
            </span>
            <input
              type="checkbox" class="switch" checked={settings.autoCreateGroups} disabled={busy}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                void act(() => save({ autoCreateGroups: on }));
              }}
            />
          </label>
        </section>

        <section class="settings-group" aria-labelledby="set-memory-h">
          <h2 class="settings-h" id="set-memory-h">Memory</h2>
          <label class="setting">
            <span class="setting-text">
              <span class="setting-name">Auto-pause tabs I haven’t used for</span>
              <span class="setting-help">Paused tabs stay in your tab strip and use no memory; click one to resume it. The tab you’re on, pinned tabs and tabs playing sound are never paused.</span>
            </span>
            <select
              class="field field-inline" value={autoValue} disabled={busy}
              onChange={(e) => {
                const v = e.currentTarget.value;
                void act(() => save({ autoSleepMinutes: v === 'off' ? null : Number(v) }));
              }}
            >
              {choices.map((c) => <option key={String(c.value)} value={c.value === null ? 'off' : String(c.value)}>{c.label}</option>)}
            </select>
          </label>
          <label class="setting">
            <span class="setting-text">
              <span class="setting-name">Remove a saved tab from Saved for later when I open it</span>
              <span class="setting-help">Turn off to keep saved tabs as a reading list.</span>
            </span>
            <input
              type="checkbox" class="switch" checked={settings.removeOnOpen} disabled={busy}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                void act(() => save({ removeOnOpen: on }));
              }}
            />
          </label>
        </section>

        <section class="settings-group" aria-labelledby="set-sync-h">
          <h2 class="settings-h" id="set-sync-h">Sync and backup</h2>
          <label class="setting">
            <span class="setting-text">
              <span class="setting-name">Sync saved tabs through my browser account</span>
              <span class="setting-help">Saved tabs (address, short title, group) and the examples you taught your groups (the title and site of tabs you moved into a group) sync. Other open tabs and sessions stay on this device.</span>
            </span>
            <input
              type="checkbox" class="switch" checked={settings.syncEnabled} disabled={busy}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                void act(() => save({ syncEnabled: on }));
              }}
            />
          </label>
          <p class={syncStatus.ok ? 'sync-status' : 'sync-status is-error'} role="status">
            {syncStatusLine(syncStatus)}
            {syncStatus.lastSyncAt !== null && <span class="muted">{` · last synced ${ago(syncStatus.lastSyncAt)}`}</span>}
          </p>
          <p class="setting-help">
            Edge and Chrome don’t sync with each other: use Export and Import to move your saved tabs between them.
          </p>
          <p class="setting-help">A device that stays offline for more than 30 days may bring back saved tabs you removed elsewhere.</p>
          <p class="setting-help">
            A backup file contains your saved tabs, your groups and your saved sessions (the addresses and titles of
            their tabs). It stays on your computer; keep it somewhere private.
          </p>
          <div class="button-row">
            <button type="button" class="btn btn-sm" disabled={busy} onClick={() => void act(async () => {
              await exportBackup();
              notify('Backup ready');
            })}>
              <DownloadIcon />Export backup
            </button>
            <button type="button" class="btn btn-sm" disabled={busy} onClick={() => fileInput.current?.click()}>
              <UploadIcon />Import backup…
            </button>
            <input
              ref={fileInput} type="file" accept="application/json,.json" class="sr-only" tabIndex={-1}
              aria-label="Import backup file" onChange={(e) => onImport(e.currentTarget)}
            />
          </div>
        </section>

        <section class="settings-group" aria-labelledby="set-look-h">
          <h2 class="settings-h" id="set-look-h">Look and browser</h2>
          <div class="setting" role="radiogroup" aria-labelledby="theme-label">
            <span class="setting-text">
              <span class="setting-name" id="theme-label">Theme</span>
            </span>
            <span class="segmented">
              {THEMES.map((t) => (
                <label key={t.value} class={settings.theme === t.value ? 'segment is-on' : 'segment'}>
                  <input
                    type="radio" name="theme" value={t.value} checked={settings.theme === t.value} disabled={busy}
                    onChange={() => void act(() => save({ theme: t.value }))}
                  />
                  {t.label}
                </label>
              ))}
            </span>
          </div>
          <div class="setting" role="radiogroup" aria-labelledby="toolbar-label">
            <span class="setting-text">
              <span class="setting-name" id="toolbar-label">Toolbar icon opens</span>
              <span class="setting-help">The side panel stays open beside your pages. Alt+Shift+S opens it either way.</span>
            </span>
            <span class="segmented">
              {TOOLBAR.map((t) => (
                <label key={t.value} class={settings.toolbarOpens === t.value ? 'segment is-on' : 'segment'}>
                  <input
                    type="radio" name="toolbar" value={t.value} checked={settings.toolbarOpens === t.value} disabled={busy}
                    onChange={() => void act(() => save({ toolbarOpens: t.value }))}
                  />
                  {t.label}
                </label>
              ))}
            </span>
          </div>
          <label class="setting">
            <span class="setting-text">
              <span class="setting-name">Mirror groups as browser tab groups</span>
              <span class="setting-help">Shows your groups in the tab strip too. Asks for the “tab groups” permission.</span>
            </span>
            <input
              type="checkbox" class="switch" checked={settings.mirrorTabGroups} disabled={busy}
              onChange={(e) => onMirror(e.currentTarget.checked)}
            />
          </label>
        </section>

        <section class="settings-group" aria-labelledby="set-privacy-h">
          <h2 class="settings-h" id="set-privacy-h">Privacy</h2>
          <p class="privacy-line">
            <ShieldIcon />
            <span>
              Tablight sees only each tab’s title and address, never your passwords, cookies, what you type or what
              is on a page.{' '}
              Nothing leaves your device except saved tabs and the examples you taught your groups, which sync
              through your browser account while sync is on. Grouping runs on your computer, and there are no analytics.{' '}
              <a class="link" href="privacy.html" target="_blank" rel="noopener">Read the privacy policy</a>
            </span>
          </p>
          <div class="setting">
            <span class="setting-text">
              <span class="setting-name">Delete all data</span>
              <span class="setting-help">
                Deletes everything Tablight stored on this device and the synced copy of your saved tabs in your
                browser account, and turns sync off here. Open tabs stay open. Uninstalling also removes the data on
                this device.
              </span>
            </span>
            <button type="button" class="btn btn-sm btn-danger" disabled={busy} onClick={onDeleteAll}>
              <TrashIcon />Delete all data
            </button>
          </div>
        </section>
        <section class="settings-group" aria-labelledby="set-about-h">
          <h2 class="settings-h" id="set-about-h">About</h2>
          <p class="about-line">
            <span class="about-name">Tablight {VERSION}</span>
            <span class="muted">Made by The Moonstone (Pvt) Ltd, Sri Lanka.</span>
          </p>
          <ul class="about-links">
            {ABOUT_LINKS.map(([href, label]) => (
              <li key={href}><a class="link" href={href} target="_blank" rel="noopener">{label}</a></li>
            ))}
          </ul>
        </section>
      </form>
    </div>
  );
}
