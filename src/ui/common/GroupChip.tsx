import { readableTextOn, safeColor } from './color';
/** A group label in the group's color, with near-black or white text for AA contrast. */
export function GroupChip({ name, color, small }: { name: string; color: string; small?: boolean }) {
  const bg = safeColor(color);
  return (
    <span class={small ? 'chip chip-sm' : 'chip'} style={{ backgroundColor: bg, color: readableTextOn(bg) }} title={name}>
      {name}
    </span>
  );
}
/** A small dot in the group's color (decorative). */
export function GroupDot({ color }: { color: string }) {
  return <span class="group-dot" style={{ backgroundColor: safeColor(color) }} aria-hidden="true" />;
}
