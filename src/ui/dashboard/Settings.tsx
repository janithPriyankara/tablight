import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { send } from '../../shared/rpc';
import type { Settings as SettingsT, SyncStatus } from '../../shared/types';
import { ago, plural } from '../common/format';
import { DownloadIcon, InfoIcon, ShieldIcon, TrashIcon, UploadIcon } from '../common/icons';
import { LOOKUP_SETTING_HINT } from '../common/LookupDialog';
import { SETTINGS_TABS, type SettingsTab, isoDate, syncStatusLine } from './views';

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
export interface ImportResult { added: number; skipped: number; skippedSessions?: number; grouped?: number }
export async function importBackup(file: File): Promise<ImportResult> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error('That file is larger than 20 MB, so it can’t be a Tablight backup.');
  const json = await file.text();
  return send<ImportResult>({ t: 'import', json });
}
/** "Imported 3 tabs · skipped 1 · 2 sessions not imported (the 14 saved sessions are full)". */
export function importNotice(r: ImportResult): string {
  return [
    `Imported ${plural(r.added, 'tab')}`,
    r.grouped ? `${plural(r.grouped, 'open tab')} moved to ${r.grouped === 1 ? 'its' : 'their'} group` : '',
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
  /** Opens the interests step (General → "Choose your interests"). */
  onInterests?: () => void;
  /** The open tab (from the hash) and the switch to another one. */
  tab: SettingsTab;
  onTab: (tab: SettingsTab) => void;
}

export function Settings({ settings, syncStatus, busy, save, act, notify, onDeleteAll, onTour, onInterests, tab, onTab }: SettingsProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  /** Set by a keyboard switch: the newly selected tab takes focus once it renders. */
  const focusTab = useRef(false);
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

  const switchTo = (t: SettingsTab) => {
    focusTab.current = true;
    onTab(t);
  };
  const onTabKey = (e: KeyboardEvent) => {
    const i = SETTINGS_TABS.findIndex((t) => t.id === tab);
    const n = SETTINGS_TABS.length;
    const to = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n
      : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    // Already there (Home on the first tab): no switch, and no focus left pending for a later render.
    if (SETTINGS_TABS[to]!.id !== tab) switchTo(SETTINGS_TABS[to]!.id);
  };
  const sw = (id: string, checked: boolean, onChange: (on: boolean) => void) => (
    <input
      id={id} type="checkbox" class="switch" checked={checked} disabled={busy}
      onChange={(e) => onChange(e.currentTarget.checked)}
    />
  );
  const segmented = <T extends string>(name: string, value: T, options: { value: T; label: string }[], onPick: (v: T) => void) => (
    <span class="segmented">
      {options.map((o) => (
        <label key={o.value} class={value === o.value ? 'segment is-on' : 'segment'}>
          <input
            type="radio" name={name} value={o.value} checked={value === o.value} disabled={busy}
            onChange={() => onPick(o.value)}
          />
          {o.label}
        </label>
      ))}
    </span>
  );
  const saveOn = (key: 'autoCreateGroups' | 'removeOnOpen' | 'syncEnabled' | 'suspiciousTabs' | 'lookupButton') => (on: boolean) =>
    void act(() => save({ [key]: on }));
  return (
    <div class="page-scroll">
      <div class="settings-tabs" role="tablist" aria-label="Settings sections">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id} type="button" role="tab" id={`set-tab-${t.id}`} aria-controls={`set-panel-${t.id}`}
            aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1}
            class={tab === t.id ? 'settings-tab is-on' : 'settings-tab'}
            ref={(el) => {
              if (el && tab === t.id && focusTab.current) {
                focusTab.current = false;
                el.focus();
              }
            }}
            onClick={() => onTab(t.id)} onKeyDown={onTabKey}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`set-panel-${tab}`} aria-labelledby={`set-tab-${tab}`}>
        <form class="settings" onSubmit={(e) => e.preventDefault()}>
          {tab === 'general' && (
            <>
              <Section id="grouping" title="Grouping">
                <SettingRow
                  id="set-autogroup" name="Create new groups automatically"
                  help="When 3 or more unsorted tabs share a topic, Tablight makes a group for them right away instead of suggesting one. You can rename or delete it; a group you delete doesn’t come back."
                >
                  {sw('set-autogroup', settings.autoCreateGroups, saveOn('autoCreateGroups'))}
                </SettingRow>
                {onInterests && (
                  <SettingRow
                    id="set-interests" name="Choose your interests" group
                    help="Pick the topics you browse most and Tablight adds a group for each. Groups you already have stay as they are."
                  >
                    <button type="button" class="btn btn-sm" disabled={busy} onClick={onInterests}>Choose…</button>
                  </SettingRow>
                )}
                <SettingRow id="set-lookup" name="Show the Look it up button" hint={LOOKUP_SETTING_HINT}>
                  {sw('set-lookup', settings.lookupButton, saveOn('lookupButton'))}
                </SettingRow>
              </Section>
              <Section id="memory" title="Tabs and memory">
                <SettingRow
                  id="set-autopause" name="Auto-pause tabs I haven’t used for"
                  help="Paused tabs stay in your tab strip and use no memory; click one to resume it. The tab you’re on, pinned tabs and tabs playing sound are never paused."
                >
                  <select
                    id="set-autopause" class="field field-inline" value={autoValue} disabled={busy}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      void act(() => save({ autoSleepMinutes: v === 'off' ? null : Number(v) }));
                    }}
                  >
                    {choices.map((c) => <option key={String(c.value)} value={c.value === null ? 'off' : String(c.value)}>{c.label}</option>)}
                  </select>
                </SettingRow>
                <SettingRow
                  id="set-removeonopen" name="Remove a saved tab from Saved for later when I open it"
                  help="Turn this off to keep saved tabs as a reading list."
                >
                  {sw('set-removeonopen', settings.removeOnOpen, saveOn('removeOnOpen'))}
                </SettingRow>
              </Section>
              <Shortcuts busy={busy} notify={notify} />
              <Section id="look" title="Appearance">
                <SettingRow id="theme" name="Theme" group>
                  {segmented('theme', settings.theme, THEMES, (v) => void act(() => save({ theme: v })))}
                </SettingRow>
                <SettingRow
                  id="toolbar" name="Toolbar icon opens" group
                  help="The side panel stays open beside your pages. Alt+Shift+S opens it either way."
                >
                  {segmented('toolbar', settings.toolbarOpens, TOOLBAR, (v) => void act(() => save({ toolbarOpens: v })))}
                </SettingRow>
                <SettingRow
                  id="set-mirror" name="Show groups as tab groups in the tab strip"
                  help="Shows your groups in the browser’s tab strip too. Asks for the “tab groups” permission."
                >
                  {sw('set-mirror', settings.mirrorTabGroups, onMirror)}
                </SettingRow>
                <SettingRow
                  id="set-suspicious" name="Point out suspicious tabs"
                  help="Flags background tabs that look like ads or scams. Nothing is closed without your click."
                >
                  {sw('set-suspicious', settings.suspiciousTabs, saveOn('suspiciousTabs'))}
                </SettingRow>
              </Section>
            </>
          )}
          {tab === 'sync' && (
            <Section id="sync" title="Sync and backup">
              <SettingRow
                id="set-sync" name="Sync saved tabs through my browser account"
                help="What syncs: saved tabs (address, short title, group) and the examples you taught your groups (the title and site of tabs you moved into a group). Other open tabs and sessions stay on this device. A device that stays offline for more than 30 days may bring back saved tabs you removed elsewhere."
              >
                {sw('set-sync', settings.syncEnabled, saveOn('syncEnabled'))}
              </SettingRow>
              <div class="setting-row">
                <p class={syncStatus.ok ? 'sync-status' : 'sync-status is-error'} role="status">
                  {syncStatusLine(syncStatus)}
                  {syncStatus.lastSyncAt !== null && <span class="muted">{` · last synced ${ago(syncStatus.lastSyncAt)}`}</span>}
                </p>
              </div>
              <SettingRow
                id="set-backup" name="Backup file" group
                help="A backup file contains your saved tabs, your groups, your open tabs’ groups and your saved sessions (the addresses and titles of their tabs). It stays on your computer; keep it somewhere private. Edge and Chrome don’t sync with each other: use Export and Import to move your saved tabs between them."
              >
                <span class="button-row">
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
                </span>
              </SettingRow>
            </Section>
          )}
          {tab === 'privacy' && (
            <>
              <Section id="privacy" title="Privacy">
                <div class="setting-row">
                  <ul class="privacy-points">
                    <li><ShieldIcon />Sees only each tab’s title and address: never passwords, cookies, what you type or what is on a page.</li>
                    <li><ShieldIcon />Grouping runs on your computer. No servers, no analytics. The only network request is the optional Look it up, after you confirm the text.</li>
                    <li>
                      <ShieldIcon />Nothing leaves your device except saved tabs and taught examples (synced through your browser account while sync is on) and, only when you click
                      Look it up and confirm, the text you saw.
                    </li>
                  </ul>
                  <a class="link privacy-link" href="privacy.html" target="_blank" rel="noopener">Read the privacy policy</a>
                </div>
              </Section>
              <Section id="delete" title="Delete all data" danger>
                <SettingRow
                  id="set-delete" name="Delete everything Tablight stored" group
                  help="Deletes everything Tablight stored on this device and the synced copy of your saved tabs in your browser account, and turns sync off here. Open tabs stay open. Uninstalling also removes the data on this device."
                >
                  <button type="button" class="btn btn-sm btn-danger" disabled={busy} onClick={onDeleteAll}>
                    <TrashIcon />Delete all data
                  </button>
                </SettingRow>
              </Section>
            </>
          )}
          {tab === 'help' && (
            <>
              {onTour && (
                <Section id="help" title="Help">
                  <SettingRow id="set-tour" name="Guided tour" group help="A short walk through every part of Tablight, using your own tabs.">
                    <button type="button" class="btn btn-sm" onClick={onTour}>Start the tour</button>
                  </SettingRow>
                </Section>
              )}
              <Section id="about" title="About">
                <div class="setting-row">
                  <p class="about-line">
                    <span class="about-name">Tablight {VERSION}</span>
                    <span class="muted">Made by The Moonstone (Pvt) Ltd, Sri Lanka.</span>
                  </p>
                  <ul class="about-links">
                    {ABOUT_LINKS.map(([href, label]) => (
                      <li key={href}><a class="link" href={href} target="_blank" rel="noopener">{label}</a></li>
                    ))}
                  </ul>
                </div>
              </Section>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
/** Where the browser lets you change an extension's shortcuts (a link to it cannot open; chrome.tabs.create can). */
export const SHORTCUTS_PAGE = 'chrome://extensions/shortcuts';
export const EDGE_SHORTCUTS_PAGE = 'edge://extensions/shortcuts';
/** The browser's shortcuts page: Edge's own address in Edge (its user agent says "Edg/"), Chrome's elsewhere. */
export function shortcutsPage(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  return ua.includes('Edg/') ? EDGE_SHORTCUTS_PAGE : SHORTCUTS_PAGE;
}
/** The default keys, shown until the browser reports the current ones (and in tests). */
const DEFAULT_SHORTCUTS: { name: string; description: string; shortcut: string }[] = [
  { name: 'open-dashboard', description: 'Open the Tablight dashboard', shortcut: 'Alt+Shift+T' },
  { name: 'open-side-panel', description: 'Open Tablight in the side panel', shortcut: 'Alt+Shift+S' },
  { name: 'prioritize-tab', description: 'Add the current tab to Priority', shortcut: 'Alt+P' },
  { name: 'unprioritize-tab', description: 'Remove the current tab from Priority', shortcut: 'Alt+Shift+P' },
];
/**
 * General → Keyboard shortcuts: each command with the key the browser has for it now (the user may have changed it,
 * or another extension may hold it: then it reads "Not set"), and a button to the browser's shortcuts page.
 */
function Shortcuts({ busy, notify }: { busy: boolean; notify: (m: string) => void }) {
  const [list, setList] = useState(DEFAULT_SHORTCUTS);
  useEffect(() => {
    if (typeof chrome === 'undefined' || typeof chrome.commands?.getAll !== 'function') return;
    chrome.commands.getAll().then((cmds) => {
      const got = cmds.filter((c) => c.name && c.description).map((c) => ({ name: c.name!, description: c.description!, shortcut: c.shortcut ?? '' }));
      if (got.length) setList(got);
    }, () => undefined);
  }, []);
  const change = () => {
    const url = shortcutsPage();
    chrome.tabs.create({ url }).catch(() => notify(`Open ${url} to change the shortcuts.`));
  };
  return (
    <Section id="keys" title="Keyboard shortcuts">
      <div class="setting-row">
        <dl class="shortcut-list">
          {list.map((c) => (
            <div key={c.name} class="shortcut">
              <dt>{c.description}</dt>
              <dd>{c.shortcut ? <kbd>{c.shortcut}</kbd> : <span class="muted">Not set</span>}</dd>
            </div>
          ))}
        </dl>
        <p class="setting-hint">
          Alt+P and Alt+Shift+P work on the tab you are on, on any web page. On a Mac they are Option+P and Option+Shift+P.
          You can change any shortcut on the browser’s shortcuts page.
        </p>
      </div>
      <SettingRow id="set-keys" name="Change shortcuts" group>
        <button type="button" class="btn btn-sm" disabled={busy} onClick={change}>Open shortcuts page</button>
      </SettingRow>
    </Section>
  );
}
/** A titled card of settings rows (the title is the region's name). */
function Section(props: { id: string; title: string; danger?: boolean; children: ComponentChildren }) {
  return (
    <section class={props.danger ? 'settings-group danger-zone' : 'settings-group'} aria-labelledby={`set-${props.id}-h`}>
      <h2 class="settings-h" id={`set-${props.id}-h`}>{props.title}</h2>
      <div class="settings-card">{props.children}</div>
    </section>
  );
}
/**
 * One setting: its name and its control on one line. The explanation is not on screen until the ⓘ button next to
 * the name is pressed (it stays in the page, hidden, and describes the control for screen readers).
 * `group`: the control is a radio group or buttons, so the name labels the row instead of one input.
 * `hint`: a short line always shown under the row (and read with the control).
 */
function SettingRow(props: { id: string; name: string; help?: string; hint?: string; group?: boolean; children: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  const helpId = `${props.id}-help`;
  const hintId = `${props.id}-hint`;
  const described = [props.hint ? hintId : '', props.help ? helpId : ''].filter(Boolean).join(' ');
  const nameId = `${props.id}-name`;
  const name = props.group
    ? <span class="setting-name" id={nameId}>{props.name}</span>
    : <label class="setting-name" id={nameId} for={props.id}>{props.name}</label>;
  return (
    <div
      class="setting-row" role={props.group ? 'group' : undefined}
      aria-labelledby={props.group ? nameId : undefined} aria-describedby={described || undefined}
    >
      <div class="setting">
        <span class="setting-text">
          {name}
          {props.help && (
            <button
              type="button" class={open ? 'info-btn is-on' : 'info-btn'} aria-expanded={open} aria-controls={helpId}
              aria-label={`About “${props.name}”`} title={open ? 'Hide explanation' : 'What does this do?'}
              onClick={() => setOpen(!open)}
            >
              <InfoIcon size={14} />
            </button>
          )}
        </span>
        {props.children}
      </div>
      {props.hint && <p class="setting-hint" id={hintId}>{props.hint}</p>}
      {props.help && <p class="setting-help" id={helpId} hidden={!open}>{props.help}</p>}
    </div>
  );
}
