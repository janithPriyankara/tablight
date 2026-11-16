import { useEffect, useState } from 'preact/hooks';
import { send } from '../../shared/rpc';
import type { Snapshot } from '../../shared/types';
import { ago, plural } from '../common/format';
import { ClockIcon, CloseIcon, StashIcon, SwitchIcon, TrashIcon } from '../common/icons';

export interface SessionSummary { id: string; takenAt: number; windows: number; tabs: number }
export type SessionActionKind = 'openAll' | 'stashAll' | 'delete';

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Saved sessions (snapshots), newest first: open all, stash all, delete; plus "Save session now". */
export function Sessions(props: {
  /** Bumped on every state refresh, so the list follows changes made elsewhere. */
  version: unknown;
  busy: boolean;
  onAction: (s: SessionSummary, action: SessionActionKind) => Promise<void>;
  onSnapshot: () => Promise<void>;
}) {
  const [list, setList] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    send<SessionSummary[]>({ t: 'sessions' }).then(
      (l) => {
        if (!live) return;
        setList(l);
        setError(null);
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [props.version]);
  return (
    <div class="page-scroll">
      <div class="page-section">
        <div class="section-row">
          <p class="muted">
            Snapshots of all your windows, taken every hour and when the browser starts. The last 14 are kept on
            this device only.
          </p>
          <button type="button" class="btn btn-sm" disabled={props.busy} onClick={() => void props.onSnapshot()}>
            <ClockIcon />Save session now
          </button>
        </div>
        {error && <p class="callout callout-error" role="alert">Couldn’t load sessions: {error}</p>}
        {!list && !error && <p class="empty" aria-busy="true">Loading sessions…</p>}
        {list && !list.length && <p class="empty">No sessions saved yet.</p>}
        {list && list.length > 0 && (
          <ul class="session-list" aria-label="Saved sessions">
            {list.map((s) => (
              <li key={s.id} class="session-row">
                <div class="session-text">
                  <span class="session-when">{when(s.takenAt)}</span>
                  <span class="muted">{`${ago(s.takenAt)} · ${plural(s.windows, 'window')} · ${plural(s.tabs, 'tab')}`}</span>
                </div>
                <div class="session-actions">
                  <button type="button" class="btn btn-sm" disabled={props.busy} onClick={() => void props.onAction(s, 'openAll')}>
                    <SwitchIcon />Open all
                  </button>
                  <button type="button" class="btn btn-sm" disabled={props.busy} onClick={() => void props.onAction(s, 'stashAll')}>
                    <StashIcon />Save all for later
                  </button>
                  <button
                    type="button" class="icon-btn" disabled={props.busy} aria-label={`Delete session from ${when(s.takenAt)}`}
                    title="Delete" onClick={() => void props.onAction(s, 'delete')}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Shown at the top of All when the startup check found the last session was not restored. */
export function LastSessionCard(props: {
  session: Snapshot;
  busy: boolean;
  onAction: (s: SessionSummary, action: 'openAll' | 'stashAll') => Promise<void>;
  onDismiss: () => void;
}) {
  const { session } = props;
  const summary: SessionSummary = {
    id: session.id, takenAt: session.takenAt, windows: session.windows.length,
    tabs: session.windows.reduce((n, w) => n + w.tabs.length, 0),
  };
  return (
    <section class="card last-session" aria-labelledby="last-session-h">
      <ClockIcon class="card-icon" />
      <div class="card-text">
        <h2 id="last-session-h" class="card-title">{`Your last session (${plural(summary.tabs, 'tab')}) wasn’t restored`}</h2>
        <p class="muted">{`From ${ago(session.takenAt)}. “Save all for later” keeps the tabs without loading them.`}</p>
      </div>
      <div class="card-actions">
        <button type="button" class="btn btn-sm" disabled={props.busy} onClick={() => void props.onAction(summary, 'openAll')}>
          <SwitchIcon />Open all
        </button>
        <button type="button" class="btn btn-sm btn-primary" disabled={props.busy} onClick={() => void props.onAction(summary, 'stashAll')}>
          <StashIcon />Save all for later
        </button>
        <button type="button" class="icon-btn" aria-label="Dismiss" title="Dismiss" onClick={props.onDismiss}>
          <CloseIcon />
        </button>
      </div>
    </section>
  );
}
