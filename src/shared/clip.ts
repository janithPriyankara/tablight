// Length cap for text that web pages control (tab titles). Chrome allows titles of thousands of characters, and the
// classifier's suffix regexes are polynomial in the input length (recheck: 2nd degree at worst), so every title is cut
// to MAX_TEXT where it enters the extension and again where those regexes run. No imports: classify/ stays pure.

/** Longest page-supplied text the extension keeps or matches. A 1,024-character worst case costs about 1 ms per regex. */
export const MAX_TEXT = 1024;

/** `s` cut to `max` UTF-16 units, never splitting a surrogate pair. */
export function clipText(s: string, max = MAX_TEXT): string {
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
