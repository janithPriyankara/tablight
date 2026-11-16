import type { Notice } from '../common/useUndo';
import { CloseIcon } from '../common/icons';
/** Bottom toast for results and errors; after a close/stash it offers Undo for 10 s (useUndo's timer). */
export function UndoToast(props: { notice: Notice | null; onUndo: () => void; onDismiss: () => void }) {
  const { notice } = props;
  return (
    <div class="toast-region" role="status" aria-live="polite">
      {notice && (
        <div class="toast">
          <span class="toast-text">
            {notice.message}
            {notice.hint && <span class="notice-hint">{notice.hint}</span>}
          </span>
          {notice.token && <button type="button" class="link toast-undo" onClick={props.onUndo}>Undo</button>}
          <button type="button" class="icon-btn toast-close" aria-label="Dismiss" onClick={props.onDismiss}>
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}
