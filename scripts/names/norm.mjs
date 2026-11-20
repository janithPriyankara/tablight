// The build-time copy of normName from src/classify/names.ts (scripts run under plain node, which cannot import .ts).
// tests/unit/names-file.test.ts asserts the two agree on a varied sample; change both together.
/** Lowercase, diacritics stripped, anything that is not a letter or digit becomes a space, collapsed and trimmed. */
export function normName(s) {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
