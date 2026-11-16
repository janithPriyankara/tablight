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
/**
 * The hue (0–360°, OKLCH) of a stored group color, or null for a grey. Group colors come from many places
 * (starter set, user picks, other devices, backups); the UI keeps only their hue and draws every group at one
 * muted lightness and chroma (--tone-l / --tone-c, set per theme), so all groups sit in a single calm palette.
 */
export function groupHue(color: string): number | null {
  const c = safeColor(color);
  const n = Number.parseInt(c.slice(1), 16);
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
  // sRGB → OKLab (Björn Ottosson).
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  if (Math.hypot(A, B) < 0.03) return null;
  return Math.round(((Math.atan2(B, A) * 180) / Math.PI + 360) % 360);
}
/** CSS color for a group's swatch: its hue at the theme's muted tone (only numbers reach the style). */
export function groupTone(color: string): string {
  const h = groupHue(color);
  return h === null ? 'var(--tone-neutral)' : `oklch(var(--tone-l) var(--tone-c) ${h})`;
}
