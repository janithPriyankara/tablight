import { useEffect, useRef } from 'preact/hooks';
import type { DashboardState } from '../../shared/types';
import { plural } from './format';
import type { UndoHook } from './useUndo';
/**
 * Announces a group the background grew on the fly ("New group: Hardware & making · 2 tabs", with Undo).
 * Seen rule: a group is announced once per page, and only when it was grown after this page loaded, so
 * opening the dashboard later never replays old notices. A notice from another action is not
 * replaced; the announcement waits until it has ended. Undo deletes the group; the background
 * remembers it was removed, so it does not grow again.
 */
export function useGrownNotice(state: DashboardState | null, hook: Pick<UndoHook, 'notice' | 'notify'>): void {
  const { notice, notify } = hook;
  // Never replace a message the person may still be using (an Undo for a closed tab, or its "Undone" result):
  // wait until the notice has ended, or the announcement would be lost.
  const busy = notice !== null;
  const loadedAt = useRef(Date.now());
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!state || busy) return;
    for (const g of state.groups) {
      if (g.grownAt === undefined || g.grownAt <= loadedAt.current || seen.current.has(g.id)) continue;
      seen.current.add(g.id);
      const n = state.items.filter((i) => i.groupId === g.id).length;
      notify(`New group: ${g.name} · ${plural(n, 'tab')}`, undefined, undefined, { t: 'groupDelete', id: g.id });
      break; // one at a time: the next waits until this one ends
    }
  }, [state, busy]);
}
