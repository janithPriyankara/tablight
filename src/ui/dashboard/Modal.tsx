import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea, a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal dialog: aria-modal, labelled by its title, focus moves in (to `[data-autofocus]` or the
 * first control), Tab/Shift+Tab stay inside, Esc and the backdrop close it, focus returns on close.
 */
export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  wide?: boolean;
}) {
  const { title, onClose, children, footer, wide } = props;
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const box = ref.current;
    const first = box?.querySelector<HTMLElement>('[data-autofocus]') ?? box?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? box)?.focus();
    return () => before?.focus?.();
  }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close.current();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const list = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!list.length) return;
    const [head, tail] = [list[0]!, list[list.length - 1]!];
    if (e.shiftKey && document.activeElement === head) {
      e.preventDefault();
      tail.focus();
    } else if (!e.shiftKey && document.activeElement === tail) {
      e.preventDefault();
      head.focus();
    }
  };
  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close.current()}>
      <div
        ref={ref} class={wide ? 'modal modal-wide' : 'modal'} role="dialog" aria-modal="true" aria-labelledby={titleId}
        tabIndex={-1} onKeyDown={onKeyDown}
      >
        <h2 class="modal-title" id={titleId}>{title}</h2>
        <div class="modal-body">{children}</div>
        {footer && <div class="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel: string;
  /** Destructive: the confirm button is red and Cancel gets the initial focus. */
  danger?: boolean;
}
export function ConfirmDialog({ opts, onDone }: { opts: ConfirmOptions; onDone: (ok: boolean) => void }) {
  return (
    <Modal
      title={opts.title} onClose={() => onDone(false)}
      footer={
        <>
          <button type="button" class="btn" data-autofocus={opts.danger ? true : undefined} onClick={() => onDone(false)}>Cancel</button>
          <button
            type="button" class={opts.danger ? 'btn btn-danger' : 'btn btn-primary'}
            data-autofocus={opts.danger ? undefined : true} onClick={() => onDone(true)}
          >
            {opts.confirmLabel}
          </button>
        </>
      }
    >
      {opts.body && <p>{opts.body}</p>}
    </Modal>
  );
}

/** Asks for a group name (new group / rename). */
export function NameDialog(props: { title: string; initial?: string; confirmLabel: string; onDone: (name: string | null) => void }) {
  const { title, initial = '', confirmLabel, onDone } = props;
  const [name, setName] = useState(initial);
  const ok = name.trim().length > 0;
  return (
    <Modal title={title} onClose={() => onDone(null)}>
      <form
        class="modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onDone(name.trim());
        }}
      >
        <label class="form-label">
          Name
          <input
            class="field" value={name} maxLength={60} data-autofocus spellcheck={false} autocomplete="off"
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </label>
        <div class="modal-foot">
          <button type="button" class="btn" onClick={() => onDone(null)}>Cancel</button>
          <button type="submit" class="btn btn-primary" disabled={!ok}>{confirmLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
