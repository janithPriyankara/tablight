import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { GroupSummary } from '../../shared/types';
import { GroupDot } from '../common/GroupChip';
import { ClockIcon, CopyIcon, GearIcon, InboxIcon, ListIcon, PlayIcon, StashIcon } from '../common/icons';
import { Suggestions } from './Suggestions';
import { type SpecialView, type View, sameView } from './views';

export interface ViewCounts { all: number; unsorted: number; duplicates: number; stashed: number }
const SPECIAL: { kind: SpecialView; label: string; icon: (p: { class?: string }) => JSX.Element }[] = [
  { kind: 'all', label: 'All tabs', icon: ListIcon },
  { kind: 'unsorted', label: 'Unsorted', icon: InboxIcon },
  { kind: 'duplicates', label: 'Duplicates', icon: CopyIcon },
  { kind: 'stashed', label: 'Saved for later', icon: StashIcon },
  { kind: 'sessions', label: 'Sessions', icon: ClockIcon },
  { kind: 'settings', label: 'Settings', icon: GearIcon },
];

export interface GroupListProps {
  view: View;
  groups: GroupSummary[];
  counts: ViewCounts;
  onView: (v: View) => void;
  /** True while items are being dragged: groups become drop targets. */
  dragging: boolean;
  onDropOn: (groupId: string) => void;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
  busy: boolean;
}

/** Left column: special views, the user's groups (drop targets), then suggested groups. */
export function GroupList(props: GroupListProps) {
  const { view, groups, counts, onView, dragging } = props;
  const [over, setOver] = useState<string | null>(null);
  const regular = groups.filter((g) => !g.suggested).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const suggested = groups.filter((g) => g.suggested);
  const countOf = (k: SpecialView) => (k in counts ? counts[k as keyof ViewCounts] : undefined);
  const current = (v: View) => (sameView(view, v) ? 'page' : undefined);
  return (
    <nav class="sidebar" aria-label="Views and groups">
      <ul class="nav-list">
        {SPECIAL.map(({ kind, label, icon: Icon }) => {
          const n = countOf(kind);
          return (
            <li key={kind}>
              <button type="button" class="nav-item" data-tour={kind} aria-current={current({ kind })} onClick={() => onView({ kind })}>
                <Icon class="nav-icon" />
                <span class="nav-name">{label}</span>
                {n !== undefined && n > 0 && <span class="nav-count">{n}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <h2 class="section-h nav-h" id="groups-h">Groups</h2>
      <ul class="nav-list" aria-labelledby="groups-h" data-tour="groups">
        {regular.map((g) => {
          const v: View = { kind: 'group', id: g.id };
          return (
            <li
              key={g.id}
              class={dragging && over === g.id ? 'drop-over' : undefined}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                if (over !== g.id) setOver(g.id);
              }}
              onDragLeave={() => setOver((o) => (o === g.id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                if (dragging) props.onDropOn(g.id);
              }}
            >
              <button
                type="button" class={g.count ? 'nav-item' : 'nav-item is-empty'} aria-current={current(v)}
                title={g.name} onClick={() => onView(v)}
              >
                <GroupDot color={g.color} />
                <span class="nav-name">{g.name}</span>
                {g.watchCount > 0 && (
                  <span class="nav-watch" title={`${g.watchCount} to watch`} aria-label={`${g.watchCount} to watch`}><PlayIcon />{g.watchCount}</span>
                )}
                <span class="nav-count">{g.count}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {suggested.length > 0 && (
        <Suggestions
          groups={suggested} view={view} onView={onView} onAccept={props.onAccept} onDismiss={props.onDismiss} busy={props.busy}
        />
      )}
    </nav>
  );
}

/** Below 900 px the column collapses into this select at the top of the page (groups and suggestions). */
export function ViewSelect({ view, groups, onView }: { view: View; groups: GroupSummary[]; onView: (v: View) => void }) {
  const value = view.kind === 'group' ? `group:${view.id}` : view.kind;
  const regular = groups.filter((g) => !g.suggested).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const suggested = groups.filter((g) => g.suggested);
  const option = (g: GroupSummary) => (
    <option key={g.id} value={`group:${g.id}`}>
      {`${g.name} (${g.count}${g.watchCount ? `, ${g.watchCount} to watch` : ''})`}
    </option>
  );
  return (
    <label class="view-select">
      <span class="sr-only">View</span>
      <select
        class="field" value={value}
        onChange={(e) => {
          const v = e.currentTarget.value;
          onView(v.startsWith('group:') ? { kind: 'group', id: v.slice(6) } : { kind: v as SpecialView });
        }}
      >
        {SPECIAL.map((s) => <option key={s.kind} value={s.kind}>{s.label}</option>)}
        <optgroup label="Groups">{regular.map(option)}</optgroup>
        {suggested.length > 0 && <optgroup label="Suggested">{suggested.map(option)}</optgroup>}
      </select>
    </label>
  );
}
