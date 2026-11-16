/** Group colors are stored as #rrggbb (user/imported values are re-checked here). */
const HEX = /^#([0-9a-f]{6})$/i;
export const FALLBACK_GROUP_COLOR = '#8d8d8d';
export const DARK_TEXT = '#111113';
export const LIGHT_TEXT = '#ffffff';
/** The color when it is a valid #rrggbb, else a neutral grey (never passes arbitrary CSS through). */
export function safeColor(color: string): string {
  return HEX.test(color) ? color.toLowerCase() : FALLBACK_GROUP_COLOR;
}
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
/** WCAG contrast ratio between two #rrggbb colors. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** Near-black or white, whichever reads better on `bg` (invalid colors are treated as the fallback grey). */
export function readableTextOn(bg: string): typeof DARK_TEXT | typeof LIGHT_TEXT {
  const c = safeColor(bg);
  return contrast(c, DARK_TEXT) >= contrast(c, LIGHT_TEXT) ? DARK_TEXT : LIGHT_TEXT;
}
