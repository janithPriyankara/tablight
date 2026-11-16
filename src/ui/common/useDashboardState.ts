import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { send } from '../../shared/rpc';
import type { DashboardState } from '../../shared/types';
export interface DashboardStateHook {
  /** null until the first reply. Kept (stale) while a refresh is in flight or after a failed one. */
  state: DashboardState | null;
  /** Message of the last failed load (also when stale state is still shown), cleared by the next success. */
  error: string | null;
  /**
   * Re-reads the state. Coalesced: while a read is in flight, any number of calls queue exactly one more
   * read after it; every caller's promise resolves once the reads it asked for are done.
   */
  refresh: () => Promise<void>;
}
/** The worker's broadcast after data changed, sent by our own extension only. */
export function isChangedBroadcast(message: unknown, sender: chrome.runtime.MessageSender | undefined): boolean {
  if (sender?.id === undefined || sender.id !== chrome.runtime.id) return false;
  if (typeof message !== 'object' || message === null) return false;
  const m = message as { target?: unknown; t?: unknown };
  return m.target === 'ui' && m.t === 'changed';
}
/**
 * Loads the `state` RPC on mount, whenever the page becomes visible again, and whenever the background
 * broadcasts `{target:'ui', t:'changed'}` (long-lived pages stay current).
 */
export function useDashboardState(): DashboardStateHook {
  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);
  const refresh = useCallback(() => {
    if (running.current) {
      dirty.current = true;
      return running.current;
    }
    const run = async () => {
      do {
        dirty.current = false;
        try {
          const s = await send<DashboardState>({ t: 'state' });
          setState(s);
          setError(null);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } while (dirty.current);
      running.current = null;
    };
    running.current = run();
    return running.current;
  }, []);
  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    // Never returns true: this listener only observes, it never answers a request.
    const onMessage = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (isChangedBroadcast(message, sender)) void refresh();
      return false;
    };
    document.addEventListener('visibilitychange', onVisible);
    const events = typeof chrome !== 'undefined' ? chrome.runtime?.onMessage : undefined;
    events?.addListener(onMessage);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      events?.removeListener(onMessage);
    };
  }, [refresh]);
  return { state, error, refresh };
}
