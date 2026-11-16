import type { ComponentChildren } from 'preact';
import type { Item } from '../../shared/types';
import { Favicon } from './Favicon';
import { GroupChip } from './GroupChip';
import { displayTitle } from './format';
const STATE_LABEL: Record<Item['state'], string | null> = { open: null, sleeping: 'Sleeping', stashed: 'Stashed' };
export interface ItemRowProps {
  item: Item;
  /** Shown as a chip after the domain. */
  group?: { name: string; color: string };
  /** Makes the row's main area a button (switch to / open the item). */
  onOpen?: (item: Item) => void;
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
export function ItemRow({ item, group, onOpen, actions, selected, meta }: ItemRowProps) {
  const title = displayTitle(item);
  const state = STATE_LABEL[item.state];
  const body = (
    <>
      <Favicon url={item.url} />
      <span class="item-text">
        <span class="item-title">{title}</span>
        <span class="item-meta">
          <span class="item-domain">{item.domain || item.url}</span>
          {meta && <span class="item-extra">{meta}</span>}
          {state && <span class={`state state-${item.state}`}>{state}</span>}
          {group && <GroupChip name={group.name} color={group.color} small />}
        </span>
      </span>
    </>
  );
  return (
    <li class={selected ? 'item-row is-selected' : 'item-row'} data-state={item.state}>
      {onOpen ? (
        <button type="button" class="item-main" title={`${title}\n${item.url}`} onClick={() => onOpen(item)}>
          {body}
        </button>
      ) : (
        <div class="item-main" title={`${title}\n${item.url}`}>{body}</div>
      )}
      {actions && <div class="item-actions">{actions}</div>}
    </li>
  );
}
