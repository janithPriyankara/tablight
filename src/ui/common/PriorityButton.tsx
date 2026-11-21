import type { Item } from '../../shared/types';
import { isPriority } from '../../shared/priority';
import { StarIcon } from './icons';

/** Whether a row offers the star: web pages only (the shortcut also ignores browser pages). */
export const canPrioritize = (item: Item): boolean => item.classifiable;
/** The star's tooltip: the default shortcut is named only for a tab (it acts on the tab you are on). */
function tooltip(item: Item, on: boolean): string {
  const label = on ? 'Remove from Priority' : 'Add to Priority';
  if (item.state === 'stashed') return label;
  return `${label} (${on ? 'Alt+Shift+P' : 'Alt+P'} on the tab; Option on a Mac)`;
}
/**
 * The star on a row: adds the tab to Priority, or takes it out (back to the group it was in). The tooltip names the
 * default shortcut (it can be changed at chrome://extensions/shortcuts).
 */
export function PriorityButton(props: { item: Item; tabIndex?: number; disabled?: boolean; onToggle: (item: Item, on: boolean) => void }) {
  const on = isPriority(props.item);
  return (
    <button
      type="button" class={on ? 'icon-btn star-btn is-on' : 'icon-btn star-btn'} tabIndex={props.tabIndex} disabled={props.disabled}
      aria-label={on ? 'Remove from Priority' : 'Add to Priority'}
      title={tooltip(props.item, on)}
      onClick={() => props.onToggle(props.item, !on)}
    >
      <StarIcon filled={on} />
    </button>
  );
}
