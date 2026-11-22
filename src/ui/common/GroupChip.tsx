import { groupTone } from './color';
import { StarIcon } from './icons';
import { PRIORITY_GROUP_ID } from '../../shared/priority';
/** A group label: the group's swatch and its name in quiet text (no filled pill). */
export function GroupChip({ name, color, small }: { name: string; color: string; small?: boolean }) {
  return (
    <span class={small ? 'chip chip-sm' : 'chip'} title={name}>
      <span class="swatch" style={{ backgroundColor: groupTone(color) }} aria-hidden="true" />
      <span class="chip-name">{name}</span>
    </span>
  );
}
/** The group's swatch on its own (decorative). */
export function GroupDot({ color }: { color: string }) {
  return <span class="group-dot" style={{ backgroundColor: groupTone(color) }} aria-hidden="true" />;
}
/** A group's mark in lists: its swatch, or a filled star for Priority. */
export function GroupMark({ group }: { group: { id: string; color: string } }) {
  return group.id === PRIORITY_GROUP_ID ? <StarIcon class="star-mark" filled /> : <GroupDot color={group.color} />;
}
