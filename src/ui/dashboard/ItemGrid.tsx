import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { GroupSummary, Item } from '../../shared/types';
import { ItemRow } from '../common/ItemRow';
import { displayTitle } from '../common/format';
import { CloseIcon, MoveIcon, PauseIcon, StashIcon, SwitchIcon, TrashIcon } from '../common/icons';

/** Fixed row height (px): keeps windowing a matter of arithmetic. Matches .grid-row in dashboard.css. */
export const ROW_HEIGHT = 52;
/** Rows rendered above and below the visible window. */
export const OVERSCAN = 10;
/** Viewport height assumed before the scroller is laid out (and in tests, where nothing is). */
const FALLBACK_HEIGHT = 800;

export type RowAction = 'sleep' | 'stash' | 'close' | 'move' | 'remove';
export type SelectMode = 'toggle' | 'range' | 'only';

export interface ItemGridProps {
  items: Item[];
  /** Accessible name of the list. */
  label: string;
  selected: ReadonlySet<string>;
  groups: ReadonlyMap<string, GroupSummary>;
  /** Show each item's group chip (off inside a group view). */
  showGroup: boolean;
  windowNo: ReadonlyMap<number, number>;
  /** Extra meta text per item (e.g. "Similar by meaning"). */
  extraMeta?: (item: Item) => string | undefined;
  onOpen: (item: Item) => void;
  onSelect: (id: string, mode: SelectMode) => void;
  onClearSelection: () => void;
  onAction: (action: RowAction, item: Item) => void;
  /** Delete key: close the selection, or the focused item when nothing is selected. */
  onDelete: (focused: Item) => void;
  onDragStart: (item: Item, e: DragEvent) => void;
  onDragEnd: () => void;
  /** Changing it scrolls back to the top and resets keyboard focus (a new view). */
  resetKey: string;
}

const hasTab = (i: Item) => i.state !== 'stashed' && i.tabId !== undefined;

/**
 * The main list, windowed by scroll position: only the visible rows plus OVERSCAN on each side exist in
 * the DOM, so 1,000+ items stay cheap. Keyboard: ↑/↓/Home/End move focus (Shift extends the selection),
 * Enter opens, Space toggles selection, Delete closes, Esc clears the selection.
 */
export function ItemGrid(props: ItemGridProps) {
  const { items, selected, onSelect } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(FALLBACK_HEIGHT);
  const [focus, setFocus] = useState(0);
  /** Row index keyboard focus should move to once it is rendered. */
  const wantFocus = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight || FALLBACK_HEIGHT);
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A new view starts at the top (not on mount: a scroll may already have happened by then).
  const lastKey = useRef(props.resetKey);
  useLayoutEffect(() => {
    if (lastKey.current === props.resetKey) return;
    lastKey.current = props.resetKey;
    if (scroller.current) scroller.current.scrollTop = 0;
    setScrollTop(0);
    setFocus(0);
    wantFocus.current = null;
  }, [props.resetKey]);

  const count = items.length;
  const focusIdx = Math.min(focus, Math.max(0, count - 1));
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(count, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  useEffect(() => {
    const want = wantFocus.current;
    if (want === null) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-index="${want}"] .item-main`);
    if (!el) return; // not rendered yet: the render after the scroll does it
    wantFocus.current = null;
    el.focus();
  });

  /** Moves keyboard focus to row i, scrolling it into view (it may not be rendered yet). */
  const moveFocus = (i: number) => {
    const el = scroller.current;
    const idx = Math.max(0, Math.min(count - 1, i));
    if (el) {
      const top = idx * ROW_HEIGHT;
      let next = el.scrollTop;
      if (top < next) next = top;
      else if (top + ROW_HEIGHT > next + height) next = top + ROW_HEIGHT - height;
      if (next !== el.scrollTop) {
        el.scrollTop = next;
        setScrollTop(next);
      }
    }
    wantFocus.current = idx;
    setFocus(idx);
    return idx;
  };

  // A live update can move the focused row (a tab above it closed): follow it, so the roving tab stop and
  // the keys below act on the row that really has focus, never on whatever now sits at the old index.
  useEffect(() => {
    const li = document.activeElement?.closest<HTMLElement>('[data-index]');
    if (!li || !scroller.current?.contains(li)) return;
    const idx = Number(li.dataset.index);
    if (Number.isInteger(idx) && idx !== focus) setFocus(idx);
  });
  const onKeyDown = (e: KeyboardEvent) => {
    if (!count) return;
    const target = e.target as HTMLElement;
    const onMain = target.classList.contains('item-main');
    const rowIdx = Number(target.closest<HTMLElement>('[data-index]')?.dataset.index);
    // A key that arrives before the previous one's focus move happened (fast typing, key repeat) continues from
    // where focus is going, not from the row that still has it; otherwise two quick ↓ would move one row.
    const pending = wantFocus.current;
    const cur = pending !== null && pending < count ? pending
      : Number.isInteger(rowIdx) && rowIdx >= 0 && rowIdx < count ? rowIdx : focusIdx;
    const step = (to: number) => {
      e.preventDefault();
      const idx = moveFocus(to);
      if (e.shiftKey) onSelect(items[idx]!.id, 'range');
    };
    switch (e.key) {
      case 'ArrowDown': return step(cur + 1);
      case 'ArrowUp': return step(cur - 1);
      case 'Home': return step(0);
      case 'End': return step(count - 1);
      case 'PageDown': return step(cur + Math.max(1, Math.floor(height / ROW_HEIGHT) - 1));
      case 'PageUp': return step(cur - Math.max(1, Math.floor(height / ROW_HEIGHT) - 1));
      case ' ':
        if (!onMain) return; // checkboxes and buttons keep their own Space
        e.preventDefault();
        onSelect(items[cur]!.id, 'toggle');
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        props.onDelete(items[cur]!);
        return;
      case 'Escape':
        if (selected.size) {
          e.preventDefault();
          props.onClearSelection();
        }
        return;
    }
  };
  // Space on a button activates it on keyup: swallow that for the row's main button (Space selects).
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === ' ' && (e.target as HTMLElement).classList.contains('item-main')) e.preventDefault();
  };
  const onFocusIn = (e: FocusEvent) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
    const idx = Number(li?.dataset.index);
    if (Number.isInteger(idx) && idx !== focusIdx) setFocus(idx);
  };

  const rows = [];
  for (let i = first; i < last; i++) {
    const item = items[i]!;
    const isSel = selected.has(item.id);
    const tab = i === focusIdx ? 0 : -1;
    const g = item.groupId !== null ? props.groups.get(item.groupId) : undefined;
    const win = item.state !== 'stashed' && item.windowId !== undefined ? props.windowNo.get(item.windowId) : undefined;
    const meta = [win !== undefined ? `Window ${win}` : '', props.extraMeta?.(item) ?? ''].filter(Boolean).join(' · ');
    const title = displayTitle(item);
    const web = item.classifiable;
    rows.push(
      <ItemRow
        key={item.id} item={item} selected={isSel} meta={meta || undefined} mainTabIndex={tab}
        {...(props.showGroup && g ? { group: g } : {})}
        onOpen={(it, e) => {
          if (e.shiftKey) onSelect(it.id, 'range');
          else if (e.metaKey || e.ctrlKey) onSelect(it.id, 'toggle');
          else props.onOpen(it);
        }}
        rowProps={{
          class: 'grid-row',
          'data-index': i,
          ...(i === 0 ? { 'data-tour': 'row' } : {}),
          draggable: true,
          onDragStart: (e: DragEvent) => props.onDragStart(item, e),
          onDragEnd: () => props.onDragEnd(),
        } as never}
        leading={
          <input
            type="checkbox" class="row-check" checked={isSel} tabIndex={tab} aria-label={`Select ${title}`}
            onClick={(e) => {
              if (e.shiftKey) {
                e.preventDefault();
                onSelect(item.id, 'range');
              }
            }}
            onChange={() => onSelect(item.id, 'toggle')}
          />
        }
        actions={
          <>
            {item.state === 'stashed' && (
              <button type="button" class="icon-btn" tabIndex={tab} aria-label="Open" title="Open" onClick={() => props.onOpen(item)}>
                <SwitchIcon />
              </button>
            )}
            {item.state === 'open' && web && (
              <button type="button" class="icon-btn" tabIndex={tab} aria-label="Pause" title="Pause: frees its memory, stays in your tab strip" onClick={() => props.onAction('sleep', item)}>
                <PauseIcon />
              </button>
            )}
            {hasTab(item) && web && (
              <button type="button" class="icon-btn" tabIndex={tab} aria-label="Save for later" title="Save for later: closes the tab and keeps it in Saved for later" onClick={() => props.onAction('stash', item)}>
                <StashIcon />
              </button>
            )}
            <button type="button" class="icon-btn" tabIndex={tab} aria-label="Move to group" title="Move to group" onClick={() => props.onAction('move', item)}>
              <MoveIcon />
            </button>
            {hasTab(item) && (
              <button type="button" class="icon-btn" tabIndex={tab} aria-label="Close" title="Close tab" onClick={() => props.onAction('close', item)}>
                <CloseIcon />
              </button>
            )}
            {item.state === 'stashed' && (
              <button type="button" class="icon-btn" tabIndex={tab} aria-label="Remove from Saved for later" title="Remove from Saved for later" onClick={() => props.onAction('remove', item)}>
                <TrashIcon />
              </button>
            )}
          </>
        }
      />,
    );
  }

  // Lengths are strings: Preact 11 no longer appends "px" to numeric style values.
  return (
    <div
      ref={scroller} class="grid-scroll" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown} onKeyUp={onKeyUp} onFocusIn={onFocusIn}
    >
      <div class="grid-spacer" style={{ height: `${count * ROW_HEIGHT}px` }}>
        <ul
          class="item-list grid-list" aria-label={props.label}
          style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}
        >
          {rows}
        </ul>
      </div>
    </div>
  );
}
