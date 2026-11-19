import { useEffect, useRef, useState } from 'preact/hooks';
import { send, type Req } from '../../shared/rpc';
/** The background keeps an undo token this long (UNDO_MS in background/memory.ts). */
export const UNDO_WINDOW_MS = 10_000;
export interface Notice { message: string; token?: string; /** A one-time explanation shown under the message. */ hint?: string;
  /** Undo runs this request instead of `undo` with a token (a grown group is undone by deleting it). */
  undoRequest?: Req }
export interface UndoHook {
  /** The current notice; it carries a token while undo is still possible. */
  notice: Notice | null;
  /** Shows a message; with a token it offers Undo for 10 s, then disappears. A hint adds a second line. */
  notify: (message: string, token?: string, hint?: string, undoRequest?: Req) => void;
  /** Sends `undo` for the current token (or the notice's own request); the caller replaces the notice with the result. Resolves to the RPC's result. */
  undo: () => Promise<boolean>;
  dismiss: () => void;
}
export function useUndo(windowMs = UNDO_WINDOW_MS): UndoHook {
  const [notice, setNotice] = useState<Notice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => clear, []);
  const notify = (message: string, token?: string, hint?: string, undoRequest?: Req) => {
    clear();
    setNotice({ message, ...(token === undefined ? {} : { token }), ...(hint === undefined ? {} : { hint }), ...(undoRequest === undefined ? {} : { undoRequest }) });
    timer.current = setTimeout(() => setNotice(null), windowMs);
  };
  const dismiss = () => {
    clear();
    setNotice(null);
  };
  const undoing = useRef(false);
  const undo = async () => {
    const token = notice?.token;
    const request = notice?.undoRequest;
    if (undoing.current) return false; // a second click while the first is in flight
    undoing.current = true;
    try {
      // The notice stays up until the RPC is done and the caller shows the result (both callers do),
      // so nothing else, such as a waiting announcement, slips in between.
      if (request) {
        await send(request);
        return true;
      }
      if (!token) return false;
      return await send<boolean>({ t: 'undo', token });
    } finally {
      undoing.current = false;
    }
  };
  return { notice, notify, undo, dismiss };
}
