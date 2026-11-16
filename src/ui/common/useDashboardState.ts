import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { send } from '../../shared/rpc';
import type { DashboardState } from '../../shared/types';
export interface DashboardStateHook {
  /** null until the first reply. Kept (stale) while a refresh is in flight or after a failed one. */
  state: DashboardState | null;
  /** Message of the last failed load, cleared by the next successful one. */
  error: string | null;
  /** Re-reads the state; overlapping calls resolve in order and only the latest reply is applied. */
  refresh: () => Promise<void>;
}
/** Loads the `state` RPC on mount and whenever the page becomes visible again. */
export function useDashboardState(): DashboardStateHook {
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const s = await send<DashboardState>({ t: 'state' });
      if (mine !== seq.current) return;
      setState(s);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);
  return { state, error, refresh };
}
