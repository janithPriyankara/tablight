// The opt-in look-up (design Part 2): the only network request Tablight makes, and only after the user clicked
// "Look it up" and confirmed the dialog. One cleaned text goes to Wikidata's public search API; the reply is
// untrusted data. Nothing here logs the text or the reply.
import { describeLabel } from '../../classify/describe';
import { send, type LabelForTextReply } from '../../shared/rpc';
import { cleanLookupText } from '../../shared/lookup-text';
import { LOOKUP_CACHE_KEY } from '../../shared/types';

export interface LookupHit {
  /** Wikidata's label for the item (plain text: render with textContent, never as HTML). */
  label: string;
  /** Wikidata's short description ('' when it had none). Plain text. */
  description: string;
  /** The id of the existing group whose label is this hit's topic, or null. */
  group: string | null;
  /** The Tablight label the description maps to (a starter group id), or null; lets the UI create that group. */
  topic: string | null;
}
export type LookupError = 'offline' | 'timeout' | 'http' | 'bad-reply';
export type LookupResult = { hits: LookupHit[] } | { error: LookupError };
export interface LookupDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** The head's label for a text (the labelForText RPC by default); null when it has none. */
  labelForText?: (t: string) => Promise<string | null>;
  /** The existing groups, to fill LookupHit.group. */
  groups?: ReadonlyArray<{ id: string }>;
}

export const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
export const LOOKUP_TIMEOUT_MS = 10_000;
/** Largest reply body read, in bytes (a 5-hit answer is a few kB). */
export const LOOKUP_MAX_BODY = 256_000;
/** Longest label or description kept, in characters. */
export const LOOKUP_MAX_FIELD = 200;
export const LOOKUP_MAX_HITS = 3;
export const LOOKUP_CACHE_MAX = 500;

/** The request URL: the fixed parameters plus `search`, encoded by URLSearchParams. */
export function lookupUrl(text: string): string {
  const url = new URL(WIKIDATA_API);
  const params: [string, string][] = [
    ['action', 'wbsearchentities'], ['search', text], ['language', 'en'], ['uselang', 'en'], ['type', 'item'],
    ['limit', '5'], ['format', 'json'], ['origin', '*'],
  ];
  for (const [k, v] of params) url.searchParams.append(k, v);
  return url.href;
}

// C0/C1 controls, and the bidi embedding/override/isolate characters that could reorder the rendered text.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
/** A reply string as plain text: control characters removed, whitespace collapsed, at most 200 characters. */
function plain(s: string): string {
  const t = s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, LOOKUP_MAX_FIELD).join('').trim();
}

/** What the cache keeps per hit: no group (that depends on the groups when it is read). */
interface CachedHit { label: string; description: string; topic: string | null }
interface CacheEntry { at: number; hits: CachedHit[] }
type Cache = Record<string, CacheEntry>;

const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
function validEntry(v: unknown): v is CacheEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as { at?: unknown; hits?: unknown };
  return typeof e.at === 'number' && Array.isArray(e.hits) && e.hits.every((h: unknown) => {
    if (typeof h !== 'object' || h === null) return false;
    const x = h as Record<string, unknown>;
    return typeof x['label'] === 'string' && typeof x['description'] === 'string' && isStrOrNull(x['topic']);
  });
}
async function readCache(): Promise<Cache> {
  try {
    const raw: unknown = (await chrome.storage.local.get(LOOKUP_CACHE_KEY))[LOOKUP_CACHE_KEY];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const out: Cache = {};
    for (const [k, v] of Object.entries(raw)) if (validEntry(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}
/** Adds an answer, keeping the newest LOOKUP_CACHE_MAX entries (the oldest are evicted first). */
async function writeCache(text: string, entry: CacheEntry): Promise<void> {
  try {
    const cache = await readCache();
    cache[text] = entry;
    const kept = Object.entries(cache).sort((a, b) => b[1].at - a[1].at).slice(0, LOOKUP_CACHE_MAX);
    await chrome.storage.local.set({ [LOOKUP_CACHE_KEY]: Object.fromEntries(kept) });
  } catch {
    // A full or unavailable storage only costs the cache.
  }
}

/** Reads at most LOOKUP_MAX_BODY bytes; null when the body is larger. */
async function readBody(res: Response): Promise<string | null> {
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > LOOKUP_MAX_BODY) return null;
  if (!res.body) {
    const t = await res.text();
    return t.length > LOOKUP_MAX_BODY ? null : t;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > LOOKUP_MAX_BODY) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** label and description strings of the reply's `search` array (every other field is ignored); null if malformed. */
function parseReply(body: string): { label: string; description: string }[] | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const search = (data as { search?: unknown }).search;
  if (!Array.isArray(search)) return null;
  const out: { label: string; description: string }[] = [];
  for (const item of search) {
    if (out.length >= LOOKUP_MAX_HITS) break;
    if (typeof item !== 'object' || item === null) continue;
    const { label, description } = item as { label?: unknown; description?: unknown };
    if (typeof label !== 'string') continue;
    const l = plain(label);
    if (!l) continue;
    out.push({ label: l, description: typeof description === 'string' ? plain(description) : '' });
  }
  return out;
}

async function request(text: string, f: typeof fetch): Promise<{ label: string; description: string }[] | LookupError> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await f(lookupUrl(text), {
      method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal,
    });
    if (res.status !== 200) return 'http';
    const body = await readBody(res);
    if (body === null) return 'bad-reply';
    return parseReply(body) ?? 'bad-reply';
  } catch {
    return controller.signal.aborted ? 'timeout' : 'offline';
  } finally {
    clearTimeout(timer);
  }
}

const defaultLabelForText = async (t: string): Promise<string | null> =>
  (await send<LabelForTextReply>({ t: 'labelForText', text: t })).label;

/**
 * Looks the text up on Wikidata (after the user confirmed it). The text is cleaned again (cleaning is idempotent);
 * an empty result sends nothing and answers 'bad-reply'. An answer already in the cache is never sent again.
 * Never throws.
 */
export async function lookUp(text: string, deps: LookupDeps = {}): Promise<LookupResult> {
  try {
    const clean = cleanLookupText(text);
    if (!clean) return { error: 'bad-reply' };
    const groupOf = (topic: string | null): string | null =>
      topic === null ? null : (deps.groups?.find((g) => g.id === topic)?.id ?? null);
    const withGroups = (hits: CachedHit[]): LookupHit[] =>
      hits.slice(0, LOOKUP_MAX_HITS).map((h) => ({ ...h, group: groupOf(h.topic) }));
    const cached = (await readCache())[clean];
    if (cached) return { hits: withGroups(cached.hits) };
    const reply = await request(clean, deps.fetch ?? fetch.bind(globalThis));
    if (typeof reply === 'string') return { error: reply };
    const labelFor = deps.labelForText ?? defaultLabelForText;
    const hits: CachedHit[] = [];
    for (const { label, description } of reply) {
      let topic = description ? describeLabel(description) : null;
      if (topic === null) {
        topic = await labelFor(description ? `${label} — ${description}` : label).catch(() => null);
      }
      hits.push({ label, description, topic: typeof topic === 'string' ? topic : null });
    }
    await writeCache(clean, { at: (deps.now ?? Date.now)(), hits });
    return { hits: withGroups(hits) };
  } catch {
    return { error: 'bad-reply' };
  }
}
