import type { GroupSummary } from '../../shared/types';
import { GroupDot } from '../common/GroupChip';
import { plural } from '../common/format';
import { CheckIcon, CloseIcon } from '../common/icons';
import { type View, sameView } from './views';

/** Groups the clustering suggested for Unsorted tabs: view, accept or dismiss each. */
export function Suggestions(props: {
  groups: GroupSummary[];
  view: View;
  onView: (v: View) => void;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
  busy: boolean;
}) {
  const { groups, view, onView, onAccept, onDismiss, busy } = props;
  return (
    <section class="suggestions" aria-labelledby="suggested-h">
      <h2 class="section-h nav-h" id="suggested-h">Suggested groups</h2>
      <ul class="nav-list">
        {groups.map((g) => {
          const v: View = { kind: 'group', id: g.id };
          return (
            <li key={g.id} class="suggestion">
              <button
                type="button" class="nav-item" aria-current={sameView(view, v) ? 'page' : undefined}
                title={`${g.name}: ${plural(g.count, 'tab')}`} onClick={() => onView(v)}
              >
                <GroupDot color={g.color} />
                <span class="nav-name">{g.name}</span>
                <span class="nav-count">{g.count}</span>
              </button>
              <span class="suggestion-actions">
                <button type="button" class="icon-btn" disabled={busy} aria-label={`Accept ${g.name}`} title="Accept" onClick={() => onAccept(g.id)}>
                  <CheckIcon />
                </button>
                <button type="button" class="icon-btn" disabled={busy} aria-label={`Dismiss ${g.name}`} title="Dismiss" onClick={() => onDismiss(g.id)}>
                  <CloseIcon />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
