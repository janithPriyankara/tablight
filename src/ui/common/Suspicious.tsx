import { useEffect, useId, useRef } from 'preact/hooks';
import { CLUE_TEXT, type Clue, type SuspiciousTab } from '../../shared/clues';
import type { Item } from '../../shared/types';
import { CheckIcon, CloseIcon, SwitchIcon } from './icons';
import { ItemRow } from './ItemRow';
import { displayTitle, plural } from './format';

/** The one explanation shown above the list (calm: Tablight never acts on its own). */
export const SUSPICIOUS_INTRO = 'These tabs opened in the background and look like ads or scams. Tablight never closes tabs on its own.';
/** "Opened by another site · Never viewed · Ad-click address". */
export const reasonsText = (clues: Clue[]): string => clues.map((c) => CLUE_TEXT[c]).join(' · ');
/** "Close 3 suspicious tabs?" */
export const closeAllTitle = (n: number): string => `Close ${plural(n, 'suspicious tab')}?`;
export const CLOSE_ALL_BODY = 'You can undo for 10 seconds.';

/**
 * The suspicious tabs with their reasons and three plain actions. The meta line is the one other lists use
 * (domain · Window N · group), so a pop-under in a hidden window can be found; the reasons get a line of
 * their own. No "New" chip: "Never viewed" already says it. The title is not a button: going to a tab that
 * looks like a scam is an explicit "Go to tab". The actions are the icon buttons used on every other row,
 * always visible here; each name includes the tab's title, as the same buttons repeat on each row.
 */
export function SuspiciousRows(props: {
  list: SuspiciousTab[];
  label: string;
  busy: boolean;
  /** Window numbers by window id (as in the other lists): adds "Window N" to the meta line. */
  windowNo?: ReadonlyMap<number, number>;
  /** The group of an item, for the chip after the domain. */
  groupOf?: (item: Item) => { name: string; color: string } | undefined;
  onGo: (s: SuspiciousTab) => void;
  onKeep: (s: SuspiciousTab) => void;
  onClose: (s: SuspiciousTab) => void;
}) {
  const { busy } = props;
  return (
    <ul class="item-list sus-list" aria-label={props.label}>
      {props.list.map((s) => {
        const title = displayTitle(s.item);
        const win = s.item.windowId !== undefined ? props.windowNo?.get(s.item.windowId) : undefined;
        const group = props.groupOf?.(s.item);
        return (
          <ItemRow
            key={s.item.id} item={s.item} note={reasonsText(s.clues)} rowProps={{ class: 'sus-row' }} hideNew
            {...(win !== undefined ? { meta: `Window ${win}` } : {})} {...(group ? { group } : {})}
            actions={
              <>
                <button type="button" class="icon-btn" aria-label={`Go to tab ${title}`} title="Go to tab" disabled={busy} onClick={() => props.onGo(s)}>
                  <SwitchIcon />
                </button>
                <button type="button" class="icon-btn" aria-label={`Keep ${title}`} title="Keep: stop pointing this tab out" disabled={busy} onClick={() => props.onKeep(s)}>
                  <CheckIcon />
                </button>
                <button type="button" class="icon-btn" aria-label={`Close ${title}`} title="Close tab" disabled={busy} onClick={() => props.onClose(s)}>
                  <CloseIcon />
                </button>
              </>
            }
          />
        );
      })}
    </ul>
  );
}
/** Titles listed in a "Close all" confirmation. Untrusted text: rendered as text nodes only. */
export function ConfirmTitles({ titles }: { titles: string[] }) {
  return <ul class="confirm-list">{titles.map((t, n) => <li key={n}>{t}</li>)}</ul>;
}

/**
 * "Close all" confirmation inside a page without modals (the side panel): Cancel has the focus, Esc
 * cancels, and nothing closes until "Close tabs".
 */
export function InlineCloseConfirm(props: { titles: string[]; onCancel: () => void; onConfirm: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div
      class="sus-confirm" role="group" aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        props.onCancel();
      }}
    >
      <p class="sus-confirm-title" id={titleId}>{closeAllTitle(props.titles.length)}</p>
      <ConfirmTitles titles={props.titles} />
      <p class="sus-confirm-body">{CLOSE_ALL_BODY}</p>
      <div class="sus-confirm-actions">
        <button ref={cancel} type="button" class="btn btn-sm" onClick={props.onCancel}>Cancel</button>
        <button type="button" class="btn btn-sm btn-danger" onClick={props.onConfirm}>Close tabs</button>
      </div>
    </div>
  );
}
