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
function fakeFetch(make: () => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async () => make());
}
const deps = (f: typeof fetch, extra: Partial<LookupDeps> = {}): LookupDeps => ({
  fetch: f, now: () => 1000, labelForText: async () => null, groups: [], ...extra,
});

describe('lookUp request', () => {
  it('sends one GET to the Wikidata search API with the fixed parameters and no credentials or referrer', async () => {
    const f = fakeFetch(() => reply({ label: 'Breaking Bad', description: 'American television series' }));
    const r = await lookUp('Breaking Bad', deps(f));
    expect(r).toEqual({ hits: [{ label: 'Breaking Bad', description: 'American television series', group: null, topic: 'tv' }] });
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
      { label: 'Some Film', description: '1999 film', group: 'movies', topic: 'movies' },
      { label: 'Gizmo', description: 'a gadget', group: null, topic: 'hardware' },
      { label: 'Nothing', description: 'unknown thing', group: null, topic: null },
    ] }); // at most 3 hits; no other field of the reply (ids, URLs) is kept
    expect(asked).toEqual(['Gizmo — a gadget', 'Nothing — unknown thing']);
    expect(JSON.stringify(r)).not.toContain('evil');
  });
  it('a failing head fallback leaves the hit without a topic', async () => {
    const f = fakeFetch(() => reply({ label: 'X', description: 'y' }));
    const r = await lookUp('x', deps(f, { labelForText: async () => { throw new Error('no model'); } }));
    expect(r).toEqual({ hits: [{ label: 'X', description: 'y', group: null, topic: null }] });
  });
  it('the second look-up of the same text uses the cache (fetch called once); groups are read fresh', async () => {
    const f = fakeFetch(() => reply({ label: 'Some Film', description: 'film' }));
    await lookUp('Some  Film', deps(f));
    const r = await lookUp('Some Film', deps(f, { groups: [{ id: 'movies' }] }));
    expect(f).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ hits: [{ label: 'Some Film', description: 'film', group: 'movies', topic: 'movies' }] });
    const stored = (await chrome.storage.local.get(LOOKUP_CACHE_KEY))[LOOKUP_CACHE_KEY];
    // Only the cleaned text, the hits and a timestamp; nothing in storage.sync.
    expect(stored).toEqual({ 'Some Film': { at: 1000, hits: [{ label: 'Some Film', description: 'film', topic: 'movies' }] } });
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
    expect(await lookUp('x', deps(f))).toEqual({ hits: [{ label: 'X', description: '', group: null, topic: null }] });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('lookUp cache and concurrency', () => {
  it('texts named like Object.prototype members are ordinary texts', async () => {
    for (const text of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const f = fakeFetch(() => reply({ label: text, description: '' }));
      expect(await lookUp(text, deps(f))).toEqual({ hits: [{ label: text, description: '', group: null, topic: null }] });
      expect(f).toHaveBeenCalledTimes(1);
      expect(await lookUp(text, deps(f))).toEqual({ hits: [{ label: text, description: '', group: null, topic: null }] });
      expect(f).toHaveBeenCalledTimes(1); // the second one came from the cache
    }
    expect(({} as Record<string, unknown>)['hits']).toBeUndefined();
  });
  it('a stored __proto__ key does not change how other entries are read', async () => {
    const stored = JSON.parse('{"__proto__": {"at": 1, "hits": []}, "x": {"at": 2, "hits": [{"label": "X", "description": "", "topic": null}]}}') as object;
    await chrome.storage.local.set({ [LOOKUP_CACHE_KEY]: stored });
    const f = fakeFetch(() => reply());
    expect(await lookUp('x', deps(f))).toEqual({ hits: [{ label: 'X', description: '', group: null, topic: null }] });
    expect(await lookUp('at', deps(f))).toEqual({ hits: [] });
    expect(f).toHaveBeenCalledTimes(1); // only 'at' was sent
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
    expect(a).toEqual({ hits: [{ label: 'Same', description: 'film', group: null, topic: 'movies' }] });
    expect(b).toEqual({ hits: [{ label: 'Same', description: 'film', group: 'movies', topic: 'movies' }] });
  });
  it('a head fallback that never answers gives up after 5 s (no topic), all hits at once', async () => {
    vi.useFakeTimers();
    const f = fakeFetch(() => reply({ label: 'A', description: 'a' }, { label: 'B', description: 'b' }, { label: 'C', description: 'film' }));
    const labelForText = vi.fn(() => new Promise<string | null>(() => undefined));
    const p = lookUp('hang', deps(f, { labelForText }));
    await vi.advanceTimersByTimeAsync(LABEL_TIMEOUT_MS);
    expect(await p).toEqual({ hits: [
      { label: 'A', description: 'a', group: null, topic: null },
      { label: 'B', description: 'b', group: null, topic: null },
      { label: 'C', description: 'film', group: null, topic: 'movies' },
    ] });
    expect(labelForText).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
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
    expect(r).toEqual({ hits: [{ label: 'X', description: 'd', group: null, topic: null }] });
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
      { label: 'Evil', description: '<img src=x onerror=alert(1)>', group: null, topic: null },
      { label: 'No desc', description: '', group: null, topic: null },
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
