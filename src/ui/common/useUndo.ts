import { useEffect, useRef, useState } from 'preact/hooks';
import { send } from '../../shared/rpc';
/** The background keeps an undo token this long (UNDO_MS in background/memory.ts). */
export const UNDO_WINDOW_MS = 10_000;
export interface Notice { message: string; token?: string; /** A one-time explanation shown under the message. */ hint?: string }
export interface UndoHook {
  /** The current notice; it carries a token while undo is still possible. */
  notice: Notice | null;
  /** Shows a message; with a token it offers Undo for 10 s, then disappears. A hint adds a second line. */
  notify: (message: string, token?: string, hint?: string) => void;
  /** Sends `undo` for the current token and clears the notice. Resolves to the RPC's result. */
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
  const notify = (message: string, token?: string, hint?: string) => {
    clear();
    setNotice({ message, ...(token === undefined ? {} : { token }), ...(hint === undefined ? {} : { hint }) });
    timer.current = setTimeout(() => setNotice(null), windowMs);
  };
  const dismiss = () => {
    clear();
    setNotice(null);
  };
  const undo = async () => {
    const token = notice?.token;
    dismiss();
    if (!token) return false;
    return send<boolean>({ t: 'undo', token });
  };
  return { notice, notify, undo, dismiss };
}
