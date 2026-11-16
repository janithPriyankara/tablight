// Pure codec for synced lessons: what the user taught each group (the text the model read for each tab they
// moved into it), so every device's copy of the bundled model learns the same thing. Everything decoded here
// comes from storage.sync and is treated as untrusted input.

/** [text the model embeds (title — site …), taught at (ms)] */
export type Lesson = [text: string, at: number];
/** Keyed by lower-cased group name; `name` keeps the display form. */
export type LessonMap = Map<string, { name: string; lessons: Lesson[] }>;

export const LESSON_KEYS = ['v1:L0', 'v1:L1'];
/** Bytes per key as chrome.storage.sync counts them (JSON of the stored string); under the 8,192 per item. */
export const LESSON_KEY_BUDGET = 7_500;
export const MAX_LESSON_TEXT = 200;
export const MAX_LESSONS_PER_GROUP = 50;
const MAX_GROUP_NAME = 60;
const MAX_GROUPS = 200;
/** A lesson stamped more than a year ahead is corruption or tampering, not a fast clock: ignored. */
const FUTURE_SLACK_MS = 365 * 86_400_000;
/** Cuts a lesson's text to MAX_LESSON_TEXT without leaving half a surrogate pair. */
export function lessonText(t: string): string {
  if (t.length <= MAX_LESSON_TEXT) return t;
  let out = t.slice(0, MAX_LESSON_TEXT);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}
const validName = (n: string) => n.trim() !== '' && n.trim().length <= MAX_GROUP_NAME;

const encoder = new TextEncoder();
const storedBytes = (value: string) => encoder.encode(JSON.stringify(value)).length;

/** Newest first, then by text: one order on every device, so equal maps encode to equal values. */
function ordered(lessons: Lesson[]): Lesson[] {
  return [...lessons].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
function capped(lessons: Lesson[]): Lesson[] {
  const byText = new Map<string, number>();
  for (const [t, at] of lessons) byText.set(t, Math.max(byText.get(t) ?? 0, at));
  return ordered([...byText]).slice(0, MAX_LESSONS_PER_GROUP);
}

/** Union by group (case-insensitive) and text, newest time kept, newest MAX_LESSONS_PER_GROUP per group. */
export function mergeLessons(a: LessonMap, b: LessonMap): LessonMap {
  const out: LessonMap = new Map();
  for (const m of [a, b]) {
    for (const [key, g] of m) {
      const cur = out.get(key);
      out.set(key, { name: cur?.name ?? g.name, lessons: [...(cur?.lessons ?? []), ...g.lessons] });
    }
  }
  for (const g of out.values()) g.lessons = capped(g.lessons);
  return out;
}

function validLesson(e: unknown, now: number): Lesson | null {
  if (!Array.isArray(e) || e.length !== 2) return null;
  const [t, at] = e as unknown[];
  if (typeof t !== 'string' || !t.trim() || t.length > MAX_LESSON_TEXT) return null;
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at > now + FUTURE_SLACK_MS) return null;
  return [t, at];
}

/**
 * Packs lessons into LESSON_KEYS, newest lessons first across all groups, never over LESSON_KEY_BUDGET per
 * key (older lessons that don't fit simply stay on the devices that have them). Keys with nothing are omitted.
 */
export function encodeLessons(m: LessonMap, now = Date.now()): Record<string, string> {
  // Only what decodeLessons accepts is written: anything else would be dropped by the other device, which
  // would then rewrite the keys without it, and the two devices would rewrite each other forever.
  const all = [...m.values()]
    .filter((g) => validName(g.name))
    .slice(0, MAX_GROUPS)
    .flatMap((g) => capped(g.lessons.flatMap((l) => {
      const v = validLesson(l, now);
      return v ? [v] : [];
    })).map((l) => ({ name: g.name.trim(), key: g.name.trim().toLowerCase(), l })))
    .sort((x, y) => y.l[1] - x.l[1] || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0) || (x.l[0] < y.l[0] ? -1 : x.l[0] > y.l[0] ? 1 : 0));
  const out: Record<string, string> = {};
  let k = 0;
  let bucket = new Map<string, { name: string; lessons: Lesson[] }>();
  const render = (b: typeof bucket) =>
    JSON.stringify([...b.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([, g]) => [g.name, ordered(g.lessons)]));
  for (const { name, key, l } of all) {
    if (k >= LESSON_KEYS.length) break;
    const next = new Map(bucket);
    const g = next.get(key);
    next.set(key, { name: g?.name ?? name, lessons: [...(g?.lessons ?? []), l] });
    if (storedBytes(render(next)) <= LESSON_KEY_BUDGET) {
      bucket = next;
      continue;
    }
    if (bucket.size) out[LESSON_KEYS[k]!] = render(bucket);
    k++;
    bucket = new Map([[key, { name, lessons: [l] }]]);
    if (k >= LESSON_KEYS.length || storedBytes(render(bucket)) > LESSON_KEY_BUDGET) break;
  }
  if (k < LESSON_KEYS.length && bucket.size) out[LESSON_KEYS[k]!] = render(bucket);
  return out;
}


/** Reads LESSON_KEYS from a storage.sync snapshot; malformed values and entries are ignored, never thrown. */
export function decodeLessons(store: Record<string, unknown>, now = Date.now()): LessonMap {
  const out: LessonMap = new Map();
  if (typeof store !== 'object' || store === null) return out;
  for (const key of LESSON_KEYS) {
    const raw = Object.hasOwn(store, key) ? store[key] : undefined;
    if (typeof raw !== 'string' || raw.length > LESSON_KEY_BUDGET * 2) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const e of parsed as unknown[]) {
      if (out.size >= MAX_GROUPS) break;
      if (!Array.isArray(e) || e.length !== 2) continue;
      const [name, list] = e as unknown[];
      if (typeof name !== 'string' || !name.trim() || name.length > MAX_GROUP_NAME || !Array.isArray(list)) continue;
      const lessons = (list as unknown[]).slice(0, MAX_LESSONS_PER_GROUP * 2)
        .map((x) => validLesson(x, now))
        .filter((x): x is Lesson => x !== null);
      if (!lessons.length) continue;
      const k = name.trim().toLowerCase();
      const cur = out.get(k);
      out.set(k, { name: cur?.name ?? name.trim(), lessons: capped([...(cur?.lessons ?? []), ...lessons]) });
    }
  }
  return out;
}
