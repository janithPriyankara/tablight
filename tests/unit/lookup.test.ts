import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';
import {
  LABEL_TIMEOUT_MS, LOOKUP_CACHE_MAX, LOOKUP_MAX_BODY, LOOKUP_TIMEOUT_MS, lookUp, type LookupDeps,
} from '../../src/ui/common/lookup';
import { LOOKUP_CACHE_KEY } from '../../src/shared/types';

let mock: ChromeMockControl;
beforeEach(() => {
  mock = installChromeMock({ windows: [] });
});
afterEach(() => {
  mock.uninstall();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' }, ...init,
  });
const reply = (...items: unknown[]): Response => json({ searchinfo: { search: 'x' }, search: items, success: 1 });
const WP = 'https://en.wikipedia.org/';
const isWp = (u: unknown): boolean => String(u).startsWith(WP);
/** Wikipedia's reply with these pages (formatversion=2); with none, its real "no results" reply (no `query`). */
const wpReply = (...pages: unknown[]): Response =>
  json(pages.length ? { batchcomplete: true, query: { pages } } : { batchcomplete: true });
/** A fetch that answers Wikidata with `make` and Wikipedia with `wiki` (by default: no results). */
function fakeFetch(make: () => Response | Promise<Response>, wiki: () => Response | Promise<Response> = () => wpReply()) {
  return vi.fn<typeof fetch>(async (u) => (isWp(u) ? wiki() : make()));
}
type FetchMock = ReturnType<typeof fakeFetch>;
const wdCalls = (f: FetchMock) => f.mock.calls.filter(([u]) => !isWp(u));
const wpCalls = (f: FetchMock) => f.mock.calls.filter(([u]) => isWp(u));
const deps = (f: typeof fetch, extra: Partial<LookupDeps> = {}): LookupDeps => ({
  fetch: f, now: () => 1000, labelForText: async () => null, groups: [], ...extra,
});

describe('lookUp request', () => {
  it('sends one GET to the Wikidata search API with the fixed parameters and no credentials or referrer', async () => {
    const f = fakeFetch(() => reply({ label: 'Breaking Bad', description: 'American television series' }));
    const r = await lookUp('Breaking Bad', deps(f));
    expect(r).toEqual({ hits: [{ label: 'Breaking Bad', description: 'American television series', group: null, topic: 'tv', source: 'wikidata' }] });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(
      'https://www.wikidata.org/w/api.php?action=wbsearchentities&search=Breaking+Bad&language=en&uselang=en&type=item&limit=5&format=json&origin=*',
    );
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(init!).sort()).toEqual(['cache', 'credentials', 'method', 'referrerPolicy', 'signal']);
  });
  it('encodes the search text as one parameter (no injection of others)', async () => {
    const f = fakeFetch(() => reply());
    await lookUp('a&format=xml#b c', deps(f));
    const u = new URL(String(f.mock.calls[0]![0]));
    expect(u.searchParams.get('search')).toBe('a&format=xml#b c');
    expect(u.searchParams.getAll('format')).toEqual(['json']);
    expect(u.hash).toBe('');
    expect(u.origin).toBe('https://www.wikidata.org');
  });
  it('sends the cleaned text, and nothing when cleaning leaves nothing', async () => {
    const f = fakeFetch(() => reply());
    await lookUp('ACS770 mail a.b@c.com 123456789', deps(f));
    expect(new URL(String(f.mock.calls[0]![0])).searchParams.get('search')).toBe('ACS770 mail');
    const g = fakeFetch(() => reply());
    expect(await lookUp('a.b@c.com 123456789', deps(g))).toEqual({ error: 'bad-reply' });
    expect(await lookUp('   ', deps(g))).toEqual({ error: 'bad-reply' });
    expect(g).not.toHaveBeenCalled();
  });
});

describe('lookUp answers', () => {
  it('maps descriptions by keyword, falls back to the head on "label — description", and fills the group', async () => {
    const f = fakeFetch(() => reply(
      { label: 'Some Film', description: '1999 film', id: 'Q1', url: 'https://evil.example/' },
      { label: 'Gizmo', description: 'a gadget', concepturi: 'https://evil.example/x' },
      { label: 'Nothing', description: 'unknown thing' },
      { label: 'Fourth', description: 'video game' },
    ));
    const asked: string[] = [];
    const labelForText = async (t: string) => {
      asked.push(t);
      return t.startsWith('Gizmo') ? 'hardware' : null;
    };
    const r = await lookUp('things', deps(f, { labelForText, groups: [{ id: 'movies' }, { id: 'news' }] }));
    expect(r).toEqual({ hits: [
      { label: 'Some Film', description: '1999 film', group: 'movies', topic: 'movies', source: 'wikidata' },
      { label: 'Gizmo', description: 'a gadget', group: null, topic: 'hardware', source: 'wikidata' },
      { label: 'Nothing', description: 'unknown thing', group: null, topic: null, source: 'wikidata' },
    ] }); // at most 3 hits; no other field of the reply (ids, URLs) is kept
    expect(asked).toEqual(['Gizmo — a gadget', 'Nothing — unknown thing']);
    expect(JSON.stringify(r)).not.toContain('evil');
  });
  it('a failing head fallback leaves the hit without a topic', async () => {
    const f = fakeFetch(() => reply({ label: 'X', description: 'y' }));
    const r = await lookUp('x', deps(f, { labelForText: async () => { throw new Error('no model'); } }));
    expect(r).toEqual({ hits: [{ label: 'X', description: 'y', group: null, topic: null, source: 'wikidata' }] });
  });
  it('the second look-up of the same text uses the cache (fetch called once); groups are read fresh', async () => {
    const f = fakeFetch(() => reply({ label: 'Some Film', description: 'film' }));
    await lookUp('Some  Film', deps(f));
    const r = await lookUp('Some Film', deps(f, { groups: [{ id: 'movies' }] }));
    expect(f).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ hits: [{ label: 'Some Film', description: 'film', group: 'movies', topic: 'movies', source: 'wikidata' }] });
    const stored = (await chrome.storage.local.get(LOOKUP_CACHE_KEY))[LOOKUP_CACHE_KEY];
    // Only the cleaned text, the hits and a timestamp; nothing in storage.sync.
    expect(stored).toEqual({ 'Some Film': { at: 1000, hits: [{ label: 'Some Film', description: 'film', topic: 'movies', source: 'wikidata' }] } });
    expect(await chrome.storage.sync.get(null)).toEqual({});
  });
  it('keeps at most 500 entries, evicting the oldest first', async () => {
    const seed: Record<string, unknown> = {};
    for (let i = 0; i < LOOKUP_CACHE_MAX; i++) seed[`t${i}`] = { at: i, hits: [] };
    await chrome.storage.local.set({ [LOOKUP_CACHE_KEY]: seed });
    const f = fakeFetch(() => reply());
    await lookUp('fresh text', deps(f, { now: () => 10_000 }));
    const stored = (await chrome.storage.local.get(LOOKUP_CACHE_KEY))[LOOKUP_CACHE_KEY] as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(LOOKUP_CACHE_MAX);
    expect(stored).toHaveProperty('fresh text');
    expect(stored).not.toHaveProperty('t0');
    expect(stored).toHaveProperty('t1');
  });
  it('ignores a malformed cache entry and asks again', async () => {
    await chrome.storage.local.set({ [LOOKUP_CACHE_KEY]: { x: { at: 'no', hits: 'no' } } });
    const f = fakeFetch(() => reply({ label: 'X', description: '' }));
    expect(await lookUp('x', deps(f))).toEqual({ hits: [{ label: 'X', description: '', group: null, topic: null, source: 'wikidata' }] });
    expect(wdCalls(f)).toHaveLength(1);
  });
});

describe('lookUp cache and concurrency', () => {
  it('texts named like Object.prototype members are ordinary texts', async () => {
    for (const text of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const f = fakeFetch(() => reply({ label: text, description: '' }));
      expect(await lookUp(text, deps(f))).toEqual({ hits: [{ label: text, description: '', group: null, topic: null, source: 'wikidata' }] });
      expect(f).toHaveBeenCalledTimes(2); // no topic: Wikipedia was asked too
      expect(await lookUp(text, deps(f))).toEqual({ hits: [{ label: text, description: '', group: null, topic: null, source: 'wikidata' }] });
      expect(f).toHaveBeenCalledTimes(2); // the second one came from the cache
    }
    expect(({} as Record<string, unknown>)['hits']).toBeUndefined();
  });
  it('a stored __proto__ key does not change how other entries are read', async () => {
    const stored = JSON.parse('{"__proto__": {"at": 1, "hits": []}, "x": {"at": 2, "hits": [{"label": "X", "description": "", "topic": null}]}}') as object;
    await chrome.storage.local.set({ [LOOKUP_CACHE_KEY]: stored });
    const f = fakeFetch(() => reply());
    expect(await lookUp('x', deps(f))).toEqual({ hits: [{ label: 'X', description: '', group: null, topic: null, source: 'wikidata' }] });
    expect(await lookUp('at', deps(f))).toEqual({ hits: [] });
    expect(wdCalls(f)).toHaveLength(1); // only 'at' was sent
  });
  it('concurrent look-ups keep every answer in the cache', async () => {
    const f = fakeFetch(() => reply());
    await Promise.all([lookUp('alpha', deps(f)), lookUp('beta', deps(f)), lookUp('gamma', deps(f))]);
    const stored = (await chrome.storage.local.get(LOOKUP_CACHE_KEY))[LOOKUP_CACHE_KEY] as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });
  it('the same text asked twice at once is sent once', async () => {
    const f = fakeFetch(() => reply({ label: 'Same', description: 'film' }));
    const [a, b] = await Promise.all([lookUp('same', deps(f)), lookUp('same', deps(f, { groups: [{ id: 'movies' }] }))]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ hits: [{ label: 'Same', description: 'film', group: null, topic: 'movies', source: 'wikidata' }] });
    expect(b).toEqual({ hits: [{ label: 'Same', description: 'film', group: 'movies', topic: 'movies', source: 'wikidata' }] });
  });
  it('a head fallback that never answers gives up after 5 s (no topic), all hits at once', async () => {
    vi.useFakeTimers();
    const f = fakeFetch(() => reply({ label: 'A', description: 'a' }, { label: 'B', description: 'b' }, { label: 'C', description: 'film' }));
    const labelForText = vi.fn(() => new Promise<string | null>(() => undefined));
    const p = lookUp('hang', deps(f, { labelForText }));
    await vi.advanceTimersByTimeAsync(LABEL_TIMEOUT_MS);
    expect(await p).toEqual({ hits: [
      { label: 'A', description: 'a', group: null, topic: null, source: 'wikidata' },
      { label: 'B', description: 'b', group: null, topic: null, source: 'wikidata' },
      { label: 'C', description: 'film', group: null, topic: 'movies', source: 'wikidata' },
    ] });
    expect(labelForText).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
describe('lookUp and "Delete all data"', () => {
  const reset = () => mock.sendMessage({ target: 'ui', t: 'reset' });
  const stored = async () => (await chrome.storage.local.get(LOOKUP_CACHE_KEY))[LOOKUP_CACHE_KEY];
  /** A fetch that answers only when `answer` is called. */
  function deferredFetch() {
    let answer!: () => void;
    const gate = new Promise<void>((res) => (answer = res));
    const f = fakeFetch(async () => {
      await gate;
      return reply({ label: 'Secret Film', description: 'film' });
    });
    return { f, answer: () => answer() };
  }
  it('an answer that arrives after the reset is shown but never written to the cache', async () => {
    const { f, answer } = deferredFetch();
    const p = lookUp('secret text', deps(f));
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1)); // the look-up is in flight
    await reset(); // the worker removed lookupCache and told the page
    answer();
    expect(await p).toEqual({ hits: [{ label: 'Secret Film', description: 'film', group: null, topic: 'movies', source: 'wikidata' }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(await stored()).toBeUndefined();
    expect(await chrome.storage.local.get(null)).toEqual({});
  });
  it('a write that landed after the worker removed the key is removed again', async () => {
    const f = fakeFetch(() => reply({ label: 'X', description: '' }));
    await lookUp('landed', deps(f));
    expect(await stored()).toHaveProperty('landed'); // as if written between the worker's remove and the message
    await reset();
    await vi.waitFor(async () => expect(await stored()).toBeUndefined());
  });
  it('the same text asked after the reset is sent afresh and cached again', async () => {
    const { f, answer } = deferredFetch();
    const p = lookUp('secret text', deps(f));
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    await reset();
    const g = fakeFetch(() => reply({ label: 'New', description: '' }));
    const q = lookUp('secret text', deps(g)); // not joined to the stale look-up
    answer();
    await p;
    expect(await q).toEqual({ hits: [{ label: 'New', description: '', group: null, topic: null, source: 'wikidata' }] });
    expect(wdCalls(g)).toHaveLength(1);
    expect(await stored()).toEqual({ 'secret text': { at: 1000, hits: [{ label: 'New', description: '', topic: null, source: 'wikidata' }] } });
  });
  it('ignores a reset message from another extension and other broadcasts', async () => {
    const { f, answer } = deferredFetch();
    const p = lookUp('kept text', deps(f));
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    await mock.sendMessage({ target: 'ui', t: 'reset' }, { id: 'other-extension' });
    await mock.sendMessage({ target: 'ui', t: 'changed' });
    answer();
    await p;
    expect(await stored()).toHaveProperty('kept text');
  });
});
describe('untrusted reply', () => {
  it('a body that stalls after the headers is a timeout', async () => {
    vi.useFakeTimers();
    const f = vi.fn<typeof fetch>(async (_u, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"search": ['));
          init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(body, { status: 200 });
    });
    const p = lookUp('stall', deps(f));
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS);
    expect(await p).toEqual({ error: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('__proto__ and constructor keys in the reply are ignored and pollute nothing', async () => {
    const body = '{"__proto__": {"polluted": 1}, "search": [{"__proto__": {"label": "P"}, "label": "X", "description": "d", "constructor": {"x": 1}}]}';
    const r = await lookUp('proto', deps(fakeFetch(() => json(body))));
    expect(r).toEqual({ hits: [{ label: 'X', description: 'd', group: null, topic: null, source: 'wikidata' }] });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['label']).toBeUndefined();
  });
  it('non-200 is an http error and is not cached', async () => {
    const f = fakeFetch(() => json({ search: [] }, { status: 503 }));
    expect(await lookUp('x', deps(f))).toEqual({ error: 'http' });
    expect(await lookUp('x', deps(f))).toEqual({ error: 'http' });
    expect(f).toHaveBeenCalledTimes(2);
    expect(await chrome.storage.local.get(LOOKUP_CACHE_KEY)).toEqual({});
  });
  it('non-JSON, a non-object or a `search` that is not an array is a bad reply', async () => {
    expect(await lookUp('x', deps(fakeFetch(() => json('<html>nope</html>'))))).toEqual({ error: 'bad-reply' });
    expect(await lookUp('x', deps(fakeFetch(() => json('null'))))).toEqual({ error: 'bad-reply' });
    expect(await lookUp('x', deps(fakeFetch(() => json({ search: { label: 'X' } }))))).toEqual({ error: 'bad-reply' });
    expect(await lookUp('x', deps(fakeFetch(() => json({ error: { code: 'x' } }))))).toEqual({ error: 'bad-reply' });
  });
  it('keeps only string labels and descriptions, as literal text', async () => {
    const f = fakeFetch(() => reply(
      { label: 'Evil', description: '<img src=x onerror=alert(1)>' },
      { label: 42, description: 'film' },
      null,
      'string item',
      { label: 'No desc', description: { html: '<b>' } },
    ));
    const r = await lookUp('x', deps(f));
    expect(r).toEqual({ hits: [
      { label: 'Evil', description: '<img src=x onerror=alert(1)>', group: null, topic: null, source: 'wikidata' },
      { label: 'No desc', description: '', group: null, topic: null, source: 'wikidata' },
    ] });
  });
  it('caps each field at 200 characters and strips control characters', async () => {
    const f = fakeFetch(() => reply({ label: 'A\u0000B‮C\nD', description: 'x'.repeat(10_000) }));
    const r = await lookUp('x', deps(f));
    if (!('hits' in r)) throw new Error('expected hits');
    expect(r.hits[0]!.label).toBe('A B C D');
    expect(r.hits[0]!.description).toBe('x'.repeat(200));
  });
  it('refuses a body over the size cap, by Content-Length or by what was read', async () => {
    const big = JSON.stringify({ search: [{ label: 'X', description: 'y'.repeat(LOOKUP_MAX_BODY) }] });
    expect(await lookUp('x', deps(fakeFetch(() => json(big))))).toEqual({ error: 'bad-reply' });
    const declared = fakeFetch(() => json({ search: [] }, { headers: { 'content-length': String(LOOKUP_MAX_BODY + 1) } }));
    expect(await lookUp('x', deps(declared))).toEqual({ error: 'bad-reply' });
  });
  it('a fetch TypeError is offline', async () => {
    const f = vi.fn<typeof fetch>(async () => { throw new TypeError('Failed to fetch'); });
    expect(await lookUp('x', deps(f))).toEqual({ error: 'offline' });
  });
  it('no answer within 10 s is a timeout (the request is aborted) and the timer is cleared on every path', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const f = vi.fn<typeof fetch>((_u, init) => new Promise<Response>((_res, rej) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    }));
    const p = lookUp('x', deps(f));
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ error: 'timeout' });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await lookUp('y', deps(fakeFetch(() => reply())));
    await lookUp('z', deps(fakeFetch(() => json('bad'))));
    await lookUp('w', deps(vi.fn<typeof fetch>(async () => { throw new TypeError('x'); })));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never throws and never logs the text or the reply', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k));
    const f = vi.fn<typeof fetch>(() => { throw new Error('sync throw'); });
    await expect(lookUp('secret words', deps(f))).resolves.toEqual({ error: 'offline' });
    await lookUp('secret words two', deps(fakeFetch(() => json('{bad'))));
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
describe('Wikipedia fallback', () => {
  const WIKIPEDIA_URL = (q: string) =>
    `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrlimit=5&gsrnamespace=0` +
    '&prop=description&format=json&formatversion=2&origin=*';
  it('is not asked when a Wikidata hit has a topic', async () => {
    const f = fakeFetch(() => reply({ label: 'Plain', description: 'thing' }, { label: 'Film X', description: '2001 film' }));
    const r = await lookUp('film x', deps(f));
    expect(f).toHaveBeenCalledTimes(1);
    expect(wpCalls(f)).toHaveLength(0);
    expect(r).toEqual({ hits: [
      { label: 'Plain', description: 'thing', group: null, topic: null, source: 'wikidata' },
      { label: 'Film X', description: '2001 film', group: null, topic: 'movies', source: 'wikidata' },
    ] });
  });
  it('Wikidata found nothing: one more GET with the same text, exact URL and options; hits tagged Wikipedia', async () => {
    const f = fakeFetch(() => reply(), () => wpReply(
      { pageid: 1, ns: 0, title: 'Zorblax Quintet', index: 1, description: 'American television series' },
    ));
    const r = await lookUp('zorblax quintet', deps(f, { groups: [{ id: 'tv' }] }));
    expect(r).toEqual({ hits: [{ label: 'Zorblax Quintet', description: 'American television series', group: 'tv', topic: 'tv', source: 'wikipedia' }] });
    expect(f).toHaveBeenCalledTimes(2);
    const [wdUrl] = f.mock.calls[0]!;
    const [url, init] = f.mock.calls[1]!;
    expect(new URL(String(wdUrl)).origin).toBe('https://www.wikidata.org'); // Wikidata first
    expect(url).toBe(WIKIPEDIA_URL('zorblax+quintet'));
    expect(new URL(String(url)).searchParams.get('gsrsearch')).toBe(new URL(String(wdUrl)).searchParams.get('search'));
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal).not.toBe(f.mock.calls[0]![1]?.signal); // its own deadline
    expect(Object.keys(init!).sort()).toEqual(['cache', 'credentials', 'method', 'referrerPolicy', 'signal']);
  });
  it('encodes the text as the one gsrsearch parameter', async () => {
    const f = fakeFetch(() => reply());
    await lookUp('a&format=xml#b c', deps(f));
    const u = new URL(String(wpCalls(f)[0]![0]));
    expect(u.searchParams.get('gsrsearch')).toBe('a&format=xml#b c');
    expect(u.searchParams.getAll('format')).toEqual(['json']);
    expect(u.searchParams.getAll('gsrlimit')).toEqual(['5']);
    expect(u.hash).toBe('');
    expect(u.origin).toBe('https://en.wikipedia.org');
  });
  it('Wikidata hits without a topic: Wikipedia is asked; its hits come first, then Wikidata\'s, deduplicated', async () => {
    const f = fakeFetch(
      () => reply({ label: 'Zorb', description: 'a thing' }, { label: 'Other', description: '' }),
      () => wpReply(
        { title: 'ZORB', index: 2, description: 'video game' },
        { title: 'Zorb ball', index: 1, description: 'sphere' },
        { title: 'zorb ball', index: 3, description: 'Sphere' },
      ),
    );
    const asked: string[] = [];
    const labelForText = async (t: string) => (asked.push(t), null);
    const r = await lookUp('zorb', deps(f, { labelForText }));
    expect(r).toEqual({ hits: [
      { label: 'Zorb ball', description: 'sphere', group: null, topic: null, source: 'wikipedia' },
      { label: 'ZORB', description: 'video game', group: null, topic: 'games', source: 'wikipedia' },
      { label: 'Other', description: '', group: null, topic: null, source: 'wikidata' },
    ] }); // Wikidata's "Zorb" is the same label as Wikipedia's "ZORB"; Wikipedia's second "zorb ball" (same description) is dropped
    // The head is asked exactly like for Wikidata hits: "title — description", or the title alone.
    expect(asked).toEqual(expect.arrayContaining(['Zorb — a thing', 'Other', 'Zorb ball — sphere']));
  });
  it('caps the combined hits at 3, in Wikipedia\'s search order (index), pages without an index last', async () => {
    const f = fakeFetch(() => reply({ label: 'WD only', description: '' }), () => wpReply(
      { title: 'No index', description: 'x' },
      { title: 'Third', index: 3 },
      { title: 'First', index: 1 },
      { title: 'Second', index: 2, description: 'film' },
    ));
    const r = await lookUp('cap', deps(f));
    if (!('hits' in r)) throw new Error('expected hits');
    expect(r.hits.map((h) => [h.label, h.source])).toEqual([['First', 'wikipedia'], ['Second', 'wikipedia'], ['Third', 'wikipedia']]);
    expect(r.hits[1]!.topic).toBe('movies');
  });
  it('is not asked when Wikidata failed: the Wikidata error is the answer', async () => {
    const cases: [typeof fetch, string][] = [
      [vi.fn<typeof fetch>(async (u) => { if (isWp(u)) return wpReply({ title: 'T', index: 1 }); throw new TypeError('x'); }), 'offline'],
      [fakeFetch(() => json({}, { status: 500 }), () => wpReply({ title: 'T', index: 1 })), 'http'],
      [fakeFetch(() => json('{bad'), () => wpReply({ title: 'T', index: 1 })), 'bad-reply'],
    ];
    for (const [f, error] of cases) {
      expect(await lookUp(`fail ${error}`, deps(f))).toEqual({ error });
      expect(vi.mocked(f).mock.calls.filter(([u]) => isWp(u))).toHaveLength(0);
    }
  });
  it('a Wikidata timeout does not ask Wikipedia either', async () => {
    vi.useFakeTimers();
    const f = vi.fn<typeof fetch>((u, init) => (isWp(u) ? Promise.resolve(wpReply()) : new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })));
    const p = lookUp('slow', deps(f));
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS);
    expect(await p).toEqual({ error: 'timeout' });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('a Wikipedia error shows Wikidata\'s hits, and caches nothing', async () => {
    const f = fakeFetch(() => reply({ label: 'Thing', description: 'unknown' }), () => json({}, { status: 503 }));
    expect(await lookUp('thing', deps(f))).toEqual({
      hits: [{ label: 'Thing', description: 'unknown', group: null, topic: null, source: 'wikidata' }], wikipediaFailed: true,
    });
    expect(await chrome.storage.local.get(LOOKUP_CACHE_KEY)).toEqual({});
    await lookUp('thing', deps(f));
    expect(wpCalls(f)).toHaveLength(2); // asking again can still reach Wikipedia
  });
  it('a Wikipedia error with no Wikidata hits is the answer, marked as Wikipedia\'s, not cached', async () => {
    const cases: [() => Response | Promise<Response>, string][] = [
      [() => json({}, { status: 429 }), 'http'],
      [() => { throw new TypeError('Failed to fetch'); }, 'offline'],
      [() => json('<html>nope</html>'), 'bad-reply'],
    ];
    for (const [wiki, error] of cases) {
      expect(await lookUp(`none ${error}`, deps(fakeFetch(() => reply(), wiki)))).toEqual({ error, from: 'wikipedia' });
    }
    expect(await chrome.storage.local.get(LOOKUP_CACHE_KEY)).toEqual({});
  });
  it('Wikipedia has its own 10 s deadline', async () => {
    vi.useFakeTimers();
    let wpSignal: AbortSignal | undefined;
    const f = vi.fn<typeof fetch>((u, init) => {
      if (!isWp(u)) return Promise.resolve(reply());
      wpSignal = init?.signal ?? undefined;
      return new Promise<Response>((_res, rej) => wpSignal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    });
    const p = lookUp('slow wiki', deps(f));
    for (let i = 0; i < 50 && f.mock.calls.length < 2; i++) await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS - 1);
    expect(wpSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ error: 'timeout', from: 'wikipedia' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('a malformed Wikipedia reply is handled (a bad reply), and Wikipedia\'s "no results" is nothing found', async () => {
    const bad: unknown[] = ['null', '[]', '"str"', { error: { code: 'x' } }, { query: [] }, { query: 'x' }, { query: { pages: {} } }, { query: { pages: 'x' } }];
    for (const [i, body] of bad.entries()) {
      const f = fakeFetch(() => reply(), () => json(typeof body === 'string' ? body : JSON.stringify(body)));
      expect(await lookUp(`malformed ${i}`, deps(f)), JSON.stringify(body)).toEqual({ error: 'bad-reply', from: 'wikipedia' });
    }
    for (const [i, body] of [{ batchcomplete: true }, { query: {} }, { query: { pages: [] } }].entries()) {
      expect(await lookUp(`empty ${i}`, deps(fakeFetch(() => reply(), () => json(body))))).toEqual({ hits: [] });
    }
  });
  it('keeps only string titles and descriptions as plain text; HTML is text, snippets and other fields are ignored', async () => {
    const f = fakeFetch(() => reply(), () => wpReply(
      { title: '<b>Bold</b> <img src=x onerror=alert(1)>', index: 1, description: '<i>desc</i>', snippet: '<span class="searchmatch">evil</span>', fullurl: 'https://evil.example/' },
      { title: 42, index: 2, description: 'film' },
      null,
      'page',
      { title: 'A\u0000B‮C\nD', index: 3, description: { html: '<b>' } },
      { title: '   ', index: 4 },
    ));
    const r = await lookUp('html', deps(f));
    expect(r).toEqual({ hits: [
      { label: '<b>Bold</b> <img src=x onerror=alert(1)>', description: '<i>desc</i>', group: null, topic: null, source: 'wikipedia' },
      { label: 'A B C D', description: '', group: null, topic: null, source: 'wikipedia' },
    ] });
    expect(JSON.stringify(r)).not.toContain('evil');
  });
  it('a Wikipedia body over the size cap is a bad reply', async () => {
    const big = JSON.stringify({ query: { pages: [{ title: 'X', index: 1, description: 'y'.repeat(LOOKUP_MAX_BODY) }] } });
    expect(await lookUp('big', deps(fakeFetch(() => reply(), () => json(big))))).toEqual({ error: 'bad-reply', from: 'wikipedia' });
  });
  it('caches the combined result under the cleaned text; the same text again sends nothing to either site', async () => {
    const f = fakeFetch(() => reply({ label: 'Gadget', description: '' }), () => wpReply({ title: 'Gadget Film', index: 1, description: '2004 film' }));
    const first = await lookUp('gadget  thing', deps(f));
    expect(f).toHaveBeenCalledTimes(2);
    const again = await lookUp('gadget thing', deps(f, { groups: [{ id: 'movies' }] }));
    expect(f).toHaveBeenCalledTimes(2);
    expect(first).toEqual({ hits: [
      { label: 'Gadget Film', description: '2004 film', group: null, topic: 'movies', source: 'wikipedia' },
      { label: 'Gadget', description: '', group: null, topic: null, source: 'wikidata' },
    ] });
    expect(again).toEqual({ hits: [
      { label: 'Gadget Film', description: '2004 film', group: 'movies', topic: 'movies', source: 'wikipedia' },
      { label: 'Gadget', description: '', group: null, topic: null, source: 'wikidata' },
    ] });
    expect((await chrome.storage.local.get(LOOKUP_CACHE_KEY))[LOOKUP_CACHE_KEY]).toEqual({ 'gadget thing': { at: 1000, hits: [
      { label: 'Gadget Film', description: '2004 film', topic: 'movies', source: 'wikipedia' },
      { label: 'Gadget', description: '', topic: null, source: 'wikidata' },
    ] } });
  });
  it('a cache entry stored before the fallback (no source) still reads, as Wikidata; an unknown source does not', async () => {
    await chrome.storage.local.set({ [LOOKUP_CACHE_KEY]: {
      old: { at: 1, hits: [{ label: 'Old', description: 'film', topic: 'movies' }] },
      odd: { at: 1, hits: [{ label: 'Odd', description: '', topic: null, source: 'elsewhere' }] },
    } });
    const f = fakeFetch(() => reply());
    expect(await lookUp('old', deps(f))).toEqual({ hits: [{ label: 'Old', description: 'film', group: null, topic: 'movies', source: 'wikidata' }] });
    expect(f).not.toHaveBeenCalled();
    expect(await lookUp('odd', deps(f))).toEqual({ hits: [] });
    expect(wdCalls(f)).toHaveLength(1);
  });
  it('a reset during the Wikipedia request: the answer is shown but never written to the cache', async () => {
    const reset = () => mock.sendMessage({ target: 'ui', t: 'reset' });
    let answer!: () => void;
    const gate = new Promise<void>((res) => (answer = res));
    const f = fakeFetch(() => reply(), async () => {
      await gate;
      return wpReply({ title: 'Secret Show', index: 1, description: 'television series' });
    });
    const p = lookUp('secret show', deps(f));
    await vi.waitFor(() => expect(wpCalls(f)).toHaveLength(1)); // Wikidata answered; Wikipedia is in flight
    await reset();
    answer();
    expect(await p).toEqual({ hits: [{ label: 'Secret Show', description: 'television series', group: null, topic: 'tv', source: 'wikipedia' }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(await chrome.storage.local.get(null)).toEqual({});
  });
});
describe('dedupe on every path', () => {
  it('Wikidata repeats are dropped whether or not Wikipedia is asked; same-named distinct items are kept', async () => {
    const topical = fakeFetch(() => reply(
      { label: 'Dune', description: '2021 film' }, { label: 'dune', description: '2021 Film' }, { label: 'Dune', description: 'novel' },
    ));
    expect(await lookUp('dune', deps(topical))).toEqual({ hits: [
      { label: 'Dune', description: '2021 film', group: null, topic: 'movies', source: 'wikidata' },
      { label: 'Dune', description: 'novel', group: null, topic: 'books', source: 'wikidata' },
    ] });
    expect(wpCalls(topical)).toHaveLength(0);
    const failing = fakeFetch(() => reply({ label: 'Same', description: 'x' }, { label: 'SAME', description: 'X' }), () => json({}, { status: 500 }));
    expect(await lookUp('same thing', deps(failing))).toEqual({
      hits: [{ label: 'Same', description: 'x', group: null, topic: null, source: 'wikidata' }], wikipediaFailed: true,
    });
  });
});
describe('cancel and reset before the Wikipedia request', () => {
  /** Wikidata answers (no hits) only when `answer` is called. */
  function heldWikidata() {
    let answer!: () => void;
    const gate = new Promise<void>((res) => (answer = res));
    const f = fakeFetch(async () => {
      await gate;
      return reply();
    }, () => wpReply({ title: 'Should Not Be Asked', index: 1 }));
    return { f, answer: () => answer() };
  }
  it('cancel while Wikidata is in flight: that request is aborted, Wikipedia is never asked, nothing is cached', async () => {
    const { f, answer } = heldWikidata();
    const c = new AbortController();
    const p = lookUp('cancel me', deps(f, { signal: c.signal }));
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const wdSignal = f.mock.calls[0]![1]!.signal!;
    c.abort();
    expect(await p).toEqual({ error: 'cancelled' });
    expect(wdSignal.aborted).toBe(true);
    answer();
    await new Promise((r) => setTimeout(r, 10));
    expect(wpCalls(f)).toHaveLength(0);
    expect(await chrome.storage.local.get(null)).toEqual({});
  });
  it('cancel during the head fallback (Wikidata answered, no topic yet): Wikipedia is never asked', async () => {
    let label!: (v: string | null) => void;
    const labelForText = () => new Promise<string | null>((res) => (label = res));
    const f = fakeFetch(() => reply({ label: 'Thing', description: 'gizmo' }), () => wpReply({ title: 'X', index: 1 }));
    const c = new AbortController();
    const p = lookUp('head wait', deps(f, { signal: c.signal, labelForText }));
    await vi.waitFor(() => expect(label).toBeTypeOf('function'));
    c.abort();
    label(null);
    expect(await p).toEqual({ error: 'cancelled' });
    await new Promise((r) => setTimeout(r, 10));
    expect(wpCalls(f)).toHaveLength(0);
  });
  it('a signal aborted before the call sends nothing at all', async () => {
    const f = fakeFetch(() => reply());
    const c = new AbortController();
    c.abort();
    expect(await lookUp('never', deps(f, { signal: c.signal }))).toEqual({ error: 'cancelled' });
    expect(f).not.toHaveBeenCalled();
  });
  it('two callers share one look-up: Wikipedia is asked while one still waits, not after both cancel', async () => {
    const one = heldWikidata();
    const a = new AbortController();
    const b = new AbortController();
    const pa = lookUp('shared', deps(one.f, { signal: a.signal }));
    const pb = lookUp('shared', deps(one.f, { signal: b.signal }));
    await vi.waitFor(() => expect(one.f).toHaveBeenCalledTimes(1));
    a.abort();
    one.answer();
    expect(await pa).toEqual({ error: 'cancelled' });
    expect(await pb).toEqual({ hits: [{ label: 'Should Not Be Asked', description: '', group: null, topic: null, source: 'wikipedia' }] });
    expect(wpCalls(one.f)).toHaveLength(1);
    const two = heldWikidata();
    const c = new AbortController();
    const d = new AbortController();
    const pc = lookUp('shared two', deps(two.f, { signal: c.signal }));
    const pd = lookUp('shared two', deps(two.f, { signal: d.signal }));
    await vi.waitFor(() => expect(two.f).toHaveBeenCalledTimes(1));
    c.abort();
    d.abort();
    two.answer();
    expect(await pc).toEqual({ error: 'cancelled' });
    expect(await pd).toEqual({ error: 'cancelled' });
    await new Promise((r) => setTimeout(r, 10));
    expect(wpCalls(two.f)).toHaveLength(0);
    // The same text asked afresh after everyone cancelled is a new look-up, not the dead one.
    const fresh = fakeFetch(() => reply({ label: 'Fresh', description: 'film' }));
    expect(await lookUp('shared two', deps(fresh))).toEqual({ hits: [{ label: 'Fresh', description: 'film', group: null, topic: 'movies', source: 'wikidata' }] });
  });
  it('"Delete all data" during the Wikidata request: Wikipedia is never asked; Wikidata\'s answer is shown, not stored', async () => {
    let answer!: () => void;
    const gate = new Promise<void>((res) => (answer = res));
    const f = fakeFetch(async () => {
      await gate;
      return reply({ label: 'Plain', description: 'thing' });
    }, () => wpReply({ title: 'X', index: 1 }));
    const p = lookUp('reset first', deps(f));
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    await mock.sendMessage({ target: 'ui', t: 'reset' });
    answer();
    expect(await p).toEqual({ hits: [{ label: 'Plain', description: 'thing', group: null, topic: null, source: 'wikidata' }] });
    await new Promise((r) => setTimeout(r, 10));
    expect(wpCalls(f)).toHaveLength(0);
    expect(await chrome.storage.local.get(null)).toEqual({});
  });
});
