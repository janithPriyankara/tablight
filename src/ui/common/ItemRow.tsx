import type { ComponentChildren, LiHTMLAttributes } from 'preact';
import type { Item } from '../../shared/types';
import { Favicon } from './Favicon';
import { GroupChip } from './GroupChip';
import { clock, displayTitle } from './format';
import { startAt } from '../../shared/url';
const STATE_LABEL: Record<Item['state'], string | null> = { open: null, sleeping: 'Paused', stashed: 'Saved' };
export interface ItemRowProps {
  item: Item;
  /** Shown as a chip after the domain. */
  group?: { name: string; color: string };
  /** Makes the row's main area a button (switch to / open the item); gets the click for its modifier keys. */
  onOpen?: (item: Item, e: MouseEvent) => void;
  /** Controls before the main area (e.g. a selection checkbox). */
  leading?: ComponentChildren;
  /** Extra attributes for the <li> (drag-and-drop, data-index, positioning). */
  rowProps?: LiHTMLAttributes<HTMLLIElement>;
  /** tabIndex of the main button (roving focus in long lists). */
  mainTabIndex?: number;
  /** Trailing controls (icon buttons). */
  actions?: ComponentChildren;
  selected?: boolean;
  /** Extra meta text after the domain, e.g. "Window 2". */
  meta?: string;
}
/**
 * One tab/stash entry: favicon, title (single line, full title + URL in the tooltip), and a meta line.
 * Title, URL and domain are untrusted: they are only ever rendered as text nodes and attributes.
 */
export function ItemRow({ item, group, onOpen, actions, selected, meta, leading, rowProps, mainTabIndex }: ItemRowProps) {
  const title = displayTitle(item);
  const state = STATE_LABEL[item.state];
  const isNew = item.state !== 'stashed' && item.opened === false;
  const from = item.kind === 'watch' ? startAt(item.url) : null;
  const body = (
    <>
      <Favicon url={item.url} />
      <span class="item-text">
        <span class="item-title">{title}</span>
        <span class="item-meta">
          <span class="item-domain">{item.domain || item.url}</span>
          {meta && <span class="item-extra">{meta}</span>}
          {from !== null && <span class="item-extra">{`from ${clock(from)}`}</span>}
          {isNew && <span class="state state-new" title="You haven’t opened this tab yet">New</span>}
          {state && <span class={`state state-${item.state}`}>{state}</span>}
          {group && <GroupChip name={group.name} color={group.color} small />}
        </span>
      </span>
    </>
  );
  return (
    <li {...rowProps} class={['item-row', selected ? 'is-selected' : '', rowProps?.class ?? ''].filter(Boolean).join(' ')} data-state={item.state}>
      {leading}
      {onOpen ? (
        <button
          type="button" class="item-main" title={`${title}\n${item.url}`} tabIndex={mainTabIndex}
          onClick={(e) => onOpen(item, e)}
        >
          {body}
        </button>
      ) : (
        <div class="item-main" title={`${title}\n${item.url}`}>{body}</div>
      )}
      {actions && <div class="item-actions">{actions}</div>}
    </li>
  );
}
