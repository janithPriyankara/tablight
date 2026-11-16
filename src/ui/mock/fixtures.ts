/**
 * Preview data: ~250 realistic tabs across 6 windows, built from the classifier fixture. Deterministic
 * (seeded shuffle), so scripts/make-preview-vectors.mjs and the preview see the same texts.
 * Only used by the UI preview, never by the shipped extension.
 */
import fixture from '../../../tests/quality/fixture.json';
import type { MockSeed } from './chrome-mock';
export interface PreviewTab {
  url: string;
  title: string;
  window: number;
  pinned: boolean;
  discarded: boolean;
  /** How long ago the tab was last used, in minutes. */
  ageMin: number;
}
export const WINDOW_COUNT = 6;
/** Sample search queries: their vectors are precomputed, so semantic search works in the preview. */
export const SAMPLE_QUERIES = [
  'agent', 'agents', 'movie to watch', 'movies', 'rust async', 'rust', 'python', 'react hooks', 'typescript',
  'recipe', 'cooking', 'flights', 'hotel', 'travel', 'music', 'podcast', 'news', 'stock market', 'invest',
  'workout', 'health', 'shopping', 'laptop deals', 'game', 'design', 'figma', 'tutorial', 'documentation',
  'machine learning', 'llm', 'docker', 'kubernetes', 'github', 'meeting', 'email',
];
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const NON_WEB: { url: string; title: string }[] = [
  { url: 'chrome://extensions/', title: 'Extensions' },
  { url: 'chrome://settings/', title: 'Settings' },
  { url: 'edge://flags/', title: 'Experiments' },
  { url: 'about:blank', title: '' },
  { url: 'chrome://newtab/', title: 'New Tab' },
  { url: 'chrome://history/', title: 'History' },
];
export function previewTabs(): PreviewTab[] {
  const rand = rng(20261116);
  // Netflix pages go to TV Series by rule (a Netflix film can't be told from a show), so the preview shows a
  // Netflix series rather than the fixture's Netflix film.
  const pool = fixture.map((f) =>
    f.url === 'https://www.netflix.com/title/81458416'
      ? { url: 'https://www.netflix.com/title/80057281', title: 'Watch Stranger Things | Netflix Official Site' }
      : { url: f.url, title: f.title });
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  const base = pool.slice(0, 220);
  // Duplicates: exact copies, plus a few with tracking noise the URL normalizer strips.
  const copies = base.slice(0, 22).map((t, k) => ({
    url: k % 4 === 3 ? `${t.url}${t.url.includes('?') ? '&' : '?'}utm_source=newsletter` : t.url,
    title: t.title,
  }));
  const all = [...base, ...copies, ...NON_WEB];
  // Window sizes are uneven, like real browsers: a big main window and some small ones.
  const weights = [0.36, 0.22, 0.16, 0.12, 0.08, 0.06];
  const tabs: PreviewTab[] = all.map((t, i) => {
    let r = rand();
    let w = 0;
    while (w < WINDOW_COUNT - 1 && r > weights[w]!) r -= weights[w++]!;
    // The duplicate copies land in a different window from the original, as when a link opens twice.
    if (i >= base.length && i < base.length + copies.length) w = (w + 1 + (i % 3)) % WINDOW_COUNT;
    return {
      ...t, window: w, pinned: false, discarded: false,
      ageMin: Math.floor(Math.pow(rand(), 2.2) * 14 * 24 * 60) + 1,
    };
  });
  // A few sleeping tabs (never the first of a window: that one is active), and some pinned ones.
  const firstOf = new Set<number>();
  for (const t of tabs) {
    if (!firstOf.has(t.window)) {
      firstOf.add(t.window);
      t.ageMin = Math.floor(rand() * 20) + 1;
    }
  }
  const act = new Set([...firstOf].map((w) => tabs.findIndex((t) => t.window === w)));
  let sleepLeft = 11;
  let pinLeft = 6;
  for (const [i, t] of tabs.entries()) {
    if (act.has(i) || t.url.startsWith('chrome') || t.url.startsWith('edge') || t.url === 'about:blank') continue;
    if (sleepLeft > 0 && i % 17 === 5) { t.discarded = true; t.ageMin += 600; sleepLeft--; }
    else if (pinLeft > 0 && i % 31 === 9) { t.pinned = true; pinLeft--; }
  }
  return tabs;
}
export function previewSeed(now = Date.now()): MockSeed {
  const tabs = previewTabs();
  const windows = Array.from({ length: WINDOW_COUNT }, (_, w) => {
    const mine = tabs.filter((t) => t.window === w);
    mine.sort((a, b) => Number(b.pinned) - Number(a.pinned)); // pinned tabs come first in a window
    return {
      tabs: mine.map((t, i) => ({
        url: t.url, title: t.title, pinned: t.pinned, discarded: t.discarded,
        active: !t.pinned && i === mine.findIndex((m) => !m.pinned && !m.discarded),
        lastAccessed: now - t.ageMin * 60_000,
      })),
    };
  });
  return { windows };
}
