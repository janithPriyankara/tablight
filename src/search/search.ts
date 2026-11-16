import type { Group, Item } from '../shared/types';
import { cosine } from '../shared/vec';
/** Only the most recent items are searched beyond this many (keeps a keystroke fast on huge indexes). */
export const MAX_SEARCH_ITEMS = 5_000;
/** Query tokens of at least this length also match words with one typo. */
export const TYPO_MIN_LENGTH = 5;
/** Prefix matching starts at this token length. */
export const PREFIX_MIN_LENGTH = 2;
const SCORE_EXACT = 3;
const SCORE_PREFIX = 2;
const SCORE_TYPO = 1;
/** Lower-case, diacritics stripped (NFD + combining marks). */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}
/** Unicode-aware tokens: runs of letters/digits. */
function tokenize(s: string): string[] {
  return fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];
}
/** True when a and b differ by at most one insertion, deletion, substitution or adjacent swap. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // transposition
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : b.slice(i + 1) === a.slice(i);
}
/** Best score of one query token against a document's tokens (0: no match). */
function tokenScore(q: string, doc: string[]): number {
  let best = 0;
  for (const d of doc) {
    if (d === q) return SCORE_EXACT;
    if (best < SCORE_PREFIX && q.length >= PREFIX_MIN_LENGTH && d.startsWith(q)) best = SCORE_PREFIX;
    else if (best < SCORE_TYPO && q.length >= TYPO_MIN_LENGTH && withinOneEdit(q, d)) best = SCORE_TYPO;
  }
  return best;
}
/**
 * Items whose title, domain or group name match every query token (case/diacritic-insensitive; prefix
 * match from 2 chars, one typo from 5). Ranked by match quality (exact > prefix > typo), then most
 * recently active. Pure: no chrome, no db.
 */
export function wordSearch(items: Item[], groups: Group[], q: string, limit = 50): Item[] {
  const qt = tokenize(q);
  if (!qt.length || limit <= 0) return [];
  const names = new Map(groups.map((g) => [g.id, g.name]));
  const pool =
    items.length > MAX_SEARCH_ITEMS
      ? [...items].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, MAX_SEARCH_ITEMS)
      : items;
  const hits: { item: Item; score: number }[] = [];
  for (const item of pool) {
    const group = item.groupId === null ? '' : (names.get(item.groupId) ?? '');
    const doc = tokenize(`${item.title} ${item.domain} ${group}`);
    let score = 0;
    for (const t of qt) {
      const s = tokenScore(t, doc);
      if (!s) {
        score = 0;
        break;
      }
      score += s;
    }
    if (score > 0) hits.push({ item, score });
  }
  hits.sort((a, b) => b.score - a.score || b.item.lastActiveAt - a.item.lastActiveAt);
  return hits.slice(0, limit).map((h) => h.item);
}
/** Items by cosine similarity to the query vector, best first, dropping anything below `min`. */
export function semanticSearch(
  qVec: ArrayLike<number>,
  items: { item: Item; vec: ArrayLike<number> }[],
  limit = 20,
  min = 0.3,
): Item[] {
  return items
    .map(({ item, vec }) => ({ item, s: cosine(qVec, vec) }))
    .filter((x) => x.s >= min)
    .sort((a, b) => b.s - a.s)
    .slice(0, Math.max(0, limit))
    .map((x) => x.item);
}
