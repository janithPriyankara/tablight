// The opt-in look-up (design Part 2): the only network request Tablight makes, and only after the user clicked
// "Look it up" and confirmed the dialog. One cleaned text goes to Wikidata's public search API and, only when that
// finds nothing with a topic, the same text goes once to English Wikipedia's search API (same click, same text). Every
// reply is untrusted data. Nothing here logs the text or the reply. Only the confirm dialog may import this module
// (LOOKUP_IMPORTERS in scripts/release-patterns.mjs; checked by a unit test and by verify-release).
import { describeLabel } from '../../classify/describe';
import { send, type LabelForTextReply } from '../../shared/rpc';
import { cleanLookupText } from '../../shared/lookup-text';
import { LOOKUP_CACHE_KEY } from '../../shared/types';

/** Which site a hit came from. */
export type LookupSource = 'wikidata' | 'wikipedia';
export interface LookupHit {
  /** Wikidata's label or the Wikipedia page title (plain text: render with textContent, never as HTML). */
  label: string;
  /** The short description ('' when there was none). Plain text. */
  description: string;
  /** The site that answered with this hit. */
  source: LookupSource;
  /** The id of the existing group whose label is this hit's topic, or null. */
  group: string | null;
  /**
   * The Tablight label the description maps to (a starter group id), or null. It can name a group that does not exist:
   * an on-demand group never created, or one the user deleted. The dialog may then offer to create it, and only on the
   * user's click.
   */
  topic: string | null;
}
/** 'cancelled': the caller's signal was aborted (Cancel, Escape or the dialog closed) before the answer came. */
export type LookupError = 'offline' | 'timeout' | 'http' | 'bad-reply' | 'cancelled';
/** `from: 'wikipedia'` when the error is Wikipedia's (Wikidata answered with nothing); absent for Wikidata's. */
export type LookupFailure = { error: LookupError; from?: 'wikipedia' };
/** `wikipediaFailed`: Wikipedia was asked but could not answer, so these are Wikidata's hits only. */
export type LookupResult = { hits: LookupHit[]; wikipediaFailed?: true } | LookupFailure;
export interface LookupDeps {
  /**
   * Aborted when the user no longer wants the answer. No request starts after that (the Wikipedia fallback included)
   * unless another caller of the same text still waits for it; when none does, the request in flight is aborted too.
   */
  signal?: AbortSignal;
  fetch?: typeof fetch;
  now?: () => number;
  /** The head's label for a text (the labelForText RPC by default); null when it has none. */
  labelForText?: (t: string) => Promise<string | null>;
  /** The existing groups, to fill LookupHit.group. */
  groups?: ReadonlyArray<{ id: string }>;
}

/** The dialog's opening sentence (design Part 2), shown every time before anything is sent. */
export const LOOKUP_DIALOG_SENTENCE =
  'Tablight will send this text to Wikimedia (Wikidata, and Wikipedia if Wikidata has no usable match) and nothing else:';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
/** Deadline of each request (Wikidata's, and Wikipedia's when it is asked). */
export const LOOKUP_TIMEOUT_MS = 10_000;
/** Deadline of each on-device head fallback (labelForText); on expiry the hit has no topic. */
export const LABEL_TIMEOUT_MS = 5_000;
/** Largest reply body read, in bytes (a 5-hit answer is a few kB). */
export const LOOKUP_MAX_BODY = 256_000;
/** Longest label or description kept, in characters. */
export const LOOKUP_MAX_FIELD = 200;
export const LOOKUP_MAX_HITS = 3;
export const LOOKUP_CACHE_MAX = 500;

/** A request URL: the fixed parameters plus the text, encoded by URLSearchParams. */
function apiUrl(base: string, params: [string, string][]): string {
  const url = new URL(base);
  for (const [k, v] of params) url.searchParams.append(k, v);
  return url.href;
}
const wikidataUrl = (text: string): string => apiUrl(WIKIDATA_API, [
  ['action', 'wbsearchentities'], ['search', text], ['language', 'en'], ['uselang', 'en'], ['type', 'item'],
  ['limit', '5'], ['format', 'json'], ['origin', '*'],
]);
/** Full-text search of articles (namespace 0) with each page's short description; no snippets, so no HTML. */
const wikipediaUrl = (text: string): string => apiUrl(WIKIPEDIA_API, [
  ['action', 'query'], ['generator', 'search'], ['gsrsearch', text], ['gsrlimit', '5'], ['gsrnamespace', '0'],
  ['prop', 'description'], ['format', 'json'], ['formatversion', '2'], ['origin', '*'],
]);

// C0/C1 controls, and the bidi embedding/override/isolate characters that could reorder the rendered text.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
/** A reply string as plain text: control characters removed, whitespace collapsed, at most 200 characters. */
function plain(s: string): string {
  const t = s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, LOOKUP_MAX_FIELD).join('').trim();
}

/**
 * What the cache keeps per hit: no group (that depends on the groups when it is read). `source` is absent in entries
 * stored before the Wikipedia fallback existed; those were all Wikidata's.
 */
interface CachedHit { label: string; description: string; topic: string | null; source?: LookupSource }
interface CacheEntry { at: number; hits: CachedHit[] }

const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
function validEntry(v: unknown): v is CacheEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as { at?: unknown; hits?: unknown };
  return typeof e.at === 'number' && Array.isArray(e.hits) && e.hits.every((h: unknown) => {
    if (typeof h !== 'object' || h === null) return false;
    const x = h as Record<string, unknown>;
    return typeof x['label'] === 'string' && typeof x['description'] === 'string' && isStrOrNull(x['topic']) &&
      (x['source'] === undefined || x['source'] === 'wikidata' || x['source'] === 'wikipedia');
  });
}
/** The stored cache as a Map (own keys only, so "constructor" or "__proto__" are ordinary texts). */
async function readCache(): Promise<Map<string, CacheEntry>> {
  const out = new Map<string, CacheEntry>();
  try {
    const raw: unknown = (await chrome.storage.local.get(LOOKUP_CACHE_KEY))[LOOKUP_CACHE_KEY];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
    for (const [k, v] of Object.entries(raw)) if (validEntry(v)) out.set(k, v);
  } catch {
    // An unreadable cache is an empty one.
  }
  return out;
}
/** Cache writes of this page, one after another; each merges into what is stored at that moment (other pages too). */
let writes: Promise<void> = Promise.resolve();
/**
 * Bumped by every "Delete all data" broadcast. A look-up remembers the epoch it started in and writes its answer only
 * if no reset came in the meantime, so an answer that arrives after the reset is shown but never stored.
 */
let epoch = 0;
/** Adds an answer, keeping the newest LOOKUP_CACHE_MAX entries (the oldest are evicted first); skipped after a reset. */
function writeCache(text: string, entry: CacheEntry, startedIn: number): Promise<void> {
  writes = writes.then(async () => {
    try {
      if (epoch !== startedIn) return;
      const cache = await readCache();
      if (epoch !== startedIn) return;
      cache.set(text, entry);
      const kept = [...cache].sort((a, b) => b[1].at - a[1].at).slice(0, LOOKUP_CACHE_MAX);
      const obj: Record<string, CacheEntry> = Object.create(null) as Record<string, CacheEntry>;
      for (const [k, v] of kept) Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
      await chrome.storage.local.set({ [LOOKUP_CACHE_KEY]: obj });
    } catch {
      // A full or unavailable storage only costs the cache.
    }
  });
  return writes;
}
/** "Delete all data" ran (the worker's broadcast, from our own extension only). */
function isResetBroadcast(message: unknown, sender: chrome.runtime.MessageSender | undefined): boolean {
  if (sender?.id === undefined || sender.id !== chrome.runtime.id) return false;
  if (typeof message !== 'object' || message === null) return false;
  const m = message as { target?: unknown; t?: unknown };
  return m.target === 'ui' && m.t === 'reset';
}
/**
 * After a reset: no look-up in flight may write any more (new epoch), the same text is asked afresh, and the key is
 * removed again after this page's pending writes (one could have landed between the worker's remove and this message).
 */
function onReset(): void {
  epoch++;
  inFlight.clear();
  writes = writes.then(() => chrome.storage.local.remove(LOOKUP_CACHE_KEY)).catch(() => undefined);
}
const onMessage = (message: unknown, sender: chrome.runtime.MessageSender): false => {
  if (isResetBroadcast(message, sender)) onReset();
  return false;
};
/** The runtime.onMessage the reset listener is on (a test installs a fresh chrome; a page has one for its life). */
let listeningOn: unknown;
function listenForReset(): void {
  try {
    const event = chrome.runtime.onMessage;
    if (event === listeningOn) return;
    event.addListener(onMessage);
    listeningOn = event;
  } catch {
    // No runtime (not an extension page): nothing can reset under us.
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

interface RawHit { label: string; description: string }
function parseJson(body: string): object | null {
  try {
    const data: unknown = JSON.parse(body);
    return typeof data === 'object' && data !== null ? data : null;
  } catch {
    return null;
  }
}
/** label and description strings of Wikidata's `search` array (every other field is ignored); null if malformed. */
function parseWikidata(body: string): RawHit[] | null {
  const data = parseJson(body);
  if (data === null) return null;
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

/**
 * title and description strings of Wikipedia's `query.pages` array, in search order (`index` ascending; a page without
 * a numeric index goes last). Every other field is ignored. No `query` (or no `pages`) is Wikipedia's "no results";
 * an `error`, or a `query` / `pages` of the wrong type, is malformed (null).
 */
function parseWikipedia(body: string): RawHit[] | null {
  const data = parseJson(body);
  if (data === null || Array.isArray(data) || 'error' in data) return null;
  const query = (data as { query?: unknown }).query;
  if (query === undefined) return [];
  if (typeof query !== 'object' || query === null || Array.isArray(query)) return null;
  const pages = (query as { pages?: unknown }).pages;
  if (pages === undefined) return [];
  if (!Array.isArray(pages)) return null;
  const ranked: { at: number; hit: RawHit }[] = [];
  for (const page of pages) {
    if (typeof page !== 'object' || page === null) continue;
    const { title, description, index } = page as { title?: unknown; description?: unknown; index?: unknown };
    if (typeof title !== 'string') continue;
    const l = plain(title);
    if (!l) continue;
    const at = typeof index === 'number' && Number.isFinite(index) ? index : Number.POSITIVE_INFINITY;
    ranked.push({ at, hit: { label: l, description: typeof description === 'string' ? plain(description) : '' } });
  }
  return ranked.sort((a, b) => a.at - b.at).slice(0, LOOKUP_MAX_HITS).map((r) => r.hit);
}

/**
 * One GET to `url` (no cookies, no referrer, no cache, its own deadline and body cap), the reply read by `parse`.
 * Nothing is sent if `stop` is already aborted; aborting it later aborts the request ('cancelled').
 */
async function request(
  url: string, parse: (body: string) => RawHit[] | null, f: typeof fetch, stop: AbortSignal,
): Promise<RawHit[] | LookupError> {
  if (stop.aborted) return 'cancelled';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  const onStop = () => controller.abort();
  stop.addEventListener('abort', onStop);
  try {
    const res = await f(url, {
      method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal,
    });
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => undefined);
      return 'http';
    }
    const body = await readBody(res);
    if (body === null) return 'bad-reply';
    return parse(body) ?? 'bad-reply';
  } catch {
    if (stop.aborted) return 'cancelled';
    return controller.signal.aborted ? 'timeout' : 'offline';
  } finally {
    clearTimeout(timer);
    stop.removeEventListener('abort', onStop);
  }
}

const defaultLabelForText = async (t: string): Promise<string | null> =>
  (await send<LabelForTextReply>({ t: 'labelForText', text: t })).label;
/** The head fallback with a deadline: null on expiry or error. */
async function headLabel(labelFor: (t: string) => Promise<string | null>, text: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<null>((res) => (timer = setTimeout(() => res(null), LABEL_TIMEOUT_MS)));
  try {
    const v = await Promise.race([labelFor(text).catch(() => null), expiry]);
    return typeof v === 'string' ? v : null;
  } finally {
    clearTimeout(timer);
  }
}
/** Topics for one site's hits: the description's keyword label, else the head's label for "label — description". */
function withTopics(raw: RawHit[], source: LookupSource, labelFor: (t: string) => Promise<string | null>): Promise<CachedHit[]> {
  return Promise.all(raw.map(async ({ label, description }): Promise<CachedHit> => {
    const topic = (description ? describeLabel(description) : null)
      ?? (await headLabel(labelFor, description ? `${label} — ${description}` : label));
    return { label, description, topic, source };
  }));
}
/**
 * The hits in the order given, without repeats, at most LOOKUP_MAX_HITS. A hit repeats a kept one when the labels match
 * (case-insensitive) and it is from the other site, or from the same site with the same description: one site's
 * distinct items that share a name (a series and a film called "Dune") are both kept.
 */
function combine(...lists: CachedHit[][]): CachedHit[] {
  const out: CachedHit[] = [];
  for (const h of lists.flat()) {
    const label = h.label.toLowerCase();
    const repeat = out.some((k) => k.label.toLowerCase() === label &&
      (k.source !== h.source || k.description.toLowerCase() === h.description.toLowerCase()));
    if (repeat) continue;
    out.push(h);
    if (out.length >= LOOKUP_MAX_HITS) break;
  }
  return out;
}
type Answer = { hits: CachedHit[]; wikipediaFailed?: true } | LookupFailure;
/**
 * A look-up of this page in flight. `wanting` counts the callers still waiting for it; when the last one cancels,
 * `stop` is aborted: the request in flight is aborted and no further request starts.
 */
interface InFlight { p: Promise<Answer>; wanting: number; stop: AbortController }
/** Look-ups of this page in flight, by cleaned text: the same text is sent once even when asked twice at once. */
const inFlight = new Map<string, InFlight>();
/**
 * Wikidata first. Only when it answered and no hit has a topic is the same text sent to Wikipedia, and only if some
 * caller still wants the answer and no reset came in meanwhile; then Wikidata's topical hits (none, by that rule) come
 * first, Wikipedia's next and Wikidata's topic-less ones last. A Wikidata error ends the look-up (Wikipedia is not
 * asked). A Wikipedia error shows Wikidata's hits (marked wikipediaFailed), or is the answer when Wikidata had none;
 * either way nothing is cached, so asking again can still reach Wikipedia. A complete answer is cached under the
 * cleaned text, so neither site is asked twice for it, unless a reset came in during either request.
 */
async function fetchHits(clean: string, deps: LookupDeps, stop: AbortSignal): Promise<Answer> {
  const startedIn = epoch;
  const cached = (await readCache()).get(clean);
  if (cached) return { hits: cached.hits };
  const f = deps.fetch ?? fetch.bind(globalThis);
  const wd = await request(wikidataUrl(clean), parseWikidata, f, stop);
  if (typeof wd === 'string') return { error: wd };
  const labelFor = deps.labelForText ?? defaultLabelForText;
  const wdHits = await withTopics(wd, 'wikidata', labelFor);
  let hits = combine(wdHits);
  if (!wdHits.some((h) => h.topic !== null)) {
    // Nobody waits any more (Cancel, Escape, the dialog closed): the text is not sent to a second site.
    if (stop.aborted) return { error: 'cancelled' };
    // "Delete all data" came in: Wikidata's answer is shown (never stored) and nothing more is sent.
    if (epoch !== startedIn) return { hits };
    const wp = await request(wikipediaUrl(clean), parseWikipedia, f, stop);
    if (wp === 'cancelled') return { error: 'cancelled' };
    if (typeof wp === 'string') return hits.length ? { hits, wikipediaFailed: true } : { error: wp, from: 'wikipedia' };
    const wpHits = await withTopics(wp, 'wikipedia', labelFor);
    hits = combine(wdHits.filter((h) => h.topic !== null), wpHits, wdHits.filter((h) => h.topic === null));
  }
  if (epoch === startedIn) await writeCache(clean, { at: (deps.now ?? Date.now)(), hits }, startedIn);
  return { hits };
}
/**
 * Looks the text up on Wikidata, then on Wikipedia if needed (after the user confirmed it). The text is cleaned again
 * (cleaning is idempotent); an empty result sends nothing and answers 'bad-reply'. An answer already in the cache is
 * never sent again. A caller whose `deps.signal` is aborted gets 'cancelled'. Never throws.
 */
export async function lookUp(text: string, deps: LookupDeps = {}): Promise<LookupResult> {
  try {
    listenForReset();
    const clean = cleanLookupText(text);
    if (!clean) return { error: 'bad-reply' };
    const signal = deps.signal;
    if (signal?.aborted) return { error: 'cancelled' };
    let entry = inFlight.get(clean);
    if (!entry) {
      const stop = new AbortController();
      const e: InFlight = { wanting: 0, stop, p: fetchHits(clean, deps, stop.signal) };
      e.p = e.p.finally(() => {
        if (inFlight.get(clean) === e) inFlight.delete(clean); // a reset may have cleared it and a new look-up begun
      });
      inFlight.set(clean, e);
      entry = e;
    }
    const joined = entry;
    joined.wanting++;
    let left = false;
    let gaveUp!: () => void;
    const cancelled = new Promise<null>((res) => (gaveUp = () => res(null)));
    const leave = () => {
      if (left) return;
      left = true;
      gaveUp(); // this caller answers at once, without waiting for the request to wind down
      if (--joined.wanting > 0) return;
      joined.stop.abort();
      if (inFlight.get(clean) === joined) inFlight.delete(clean); // the same text asked later is sent afresh
    };
    signal?.addEventListener('abort', leave, { once: true });
    let answer: Answer | null;
    try {
      answer = await Promise.race([joined.p, cancelled]);
    } finally {
      signal?.removeEventListener('abort', leave);
    }
    if (answer === null || signal?.aborted) return { error: 'cancelled' };
    if ('error' in answer) return answer.from ? { error: answer.error, from: answer.from } : { error: answer.error };
    const groupOf = (topic: string | null): string | null =>
      topic === null ? null : (deps.groups?.find((g) => g.id === topic)?.id ?? null);
    const hits = answer.hits.slice(0, LOOKUP_MAX_HITS).map((h) => ({
      label: h.label, description: h.description, topic: h.topic, source: h.source ?? 'wikidata', group: groupOf(h.topic),
    }));
    return answer.wikipediaFailed ? { hits, wikipediaFailed: true } : { hits };
  } catch {
    return { error: 'bad-reply' };
  }
}

listenForReset(); // at load, so a page hears a reset even before its first look-up
