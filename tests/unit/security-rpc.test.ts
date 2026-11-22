// Misuse of the message API. (1) Only this extension's own pages reach the handlers: other extensions, web pages and
// content scripts, unknown request types and malformed messages are ignored. (2) Every request type, fed hostile
// payloads, settles promptly (resolves, or rejects with an Error), pollutes no prototype, leaves the database usable,
// and (privacy) never touches the network: the opt-in look-up is off by default and nothing else may call out.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installChromeMock, type ChromeMockControl } from '../../src/ui/mock/chrome-mock';

vi.mock('../../src/background/embedder', () => ({
  embed: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.05))),
  isWarm: vi.fn(() => false),
  closeIfIdle: vi.fn(async () => undefined),
  OFFSCREEN_IDLE_ALARM: 'offscreen-idle',
}));

describe('sender gate (shared/rpc handle)', () => {
  type Listener = (m: unknown, s: chrome.runtime.MessageSender, r: (x: unknown) => void) => boolean | undefined;
  let listener: Listener;
  const h = vi.fn(async () => 'ok');
  beforeAll(async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'me',
        getURL: (p: string) => `chrome-extension://me/${p}`,
        onMessage: { addListener: (fn: Listener) => (listener = fn) },
      },
    });
    const { handle } = await import('../../src/shared/rpc');
    handle(h);
  });
  afterAll(() => vi.unstubAllGlobals());
  const ours = { id: 'me', url: 'chrome-extension://me/dashboard.html' };
  const cases: [string, unknown, chrome.runtime.MessageSender][] = [
    ['another extension', { t: 'state' }, { id: 'evil', url: 'chrome-extension://evil/x.html' }],
    ['a web page (content-script context)', { t: 'state' }, { id: 'me', url: 'https://evil.example.com/', tab: { id: 1 } as chrome.tabs.Tab }],
    ['our id but a look-alike URL', { t: 'state' }, { id: 'me', url: 'chrome-extension://me.evil/x.html' }],
    ['an unknown request type', { t: 'eval' }, ours],
    ['a prototype key as the type', { t: '__proto__' }, ours],
    ['a non-object message', 'state', ours],
    ['null', null, ours],
    ['a message for the offscreen document', { t: 'state', target: 'offscreen' }, ours],
  ];
  for (const [what, msg, sender] of cases) {
    it(`ignores ${what}`, () => {
      h.mockClear();
      const respond = vi.fn();
      expect(listener(msg, sender, respond)).toBe(false);
      expect(h).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
    });
  }
  it('accepts our own page, and an error reaches the caller as a message, not a crash', async () => {
    const respond = vi.fn();
    h.mockResolvedValueOnce('ok');
    expect(listener({ t: 'state' }, ours, respond)).toBe(true);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith({ ok: true, data: 'ok' }));
    const respond2 = vi.fn();
    h.mockRejectedValueOnce(new Error('bad input'));
    listener({ t: 'state' }, ours, respond2);
    await vi.waitFor(() => expect(respond2).toHaveBeenCalledWith({ ok: false, error: 'bad input' }));
  });
});

describe('hostile payloads for every request type', () => {
  let mock: ChromeMockControl;
  let bg: typeof import('../../src/background/index');
  // Only the extension's own files (the bundled name list) may be fetched; anything else would be network traffic.
  const fetched: string[] = [];
  const fetchSpy = vi.fn(async (input: unknown) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    throw new Error('fetch is stubbed in this test');
  });
  // The request types, read from the allowlist itself so a new type is fuzzed too.
  const types = [...readFileSync('src/shared/rpc.ts', 'utf8').match(/const REQ_TYPES[^;]*;/s)![0].matchAll(/'([a-zA-Z]+)'/g)]
    .map((m) => m[1]!)
    .filter((t) => t !== 'embed' && t !== 'offscreenIdle'); // offscreen document's and idle-close: not data handlers
  const FIELDS = ['ids', 'id', 'groupId', 'name', 'from', 'into', 'on', 'command', 'tabId', 'json', 'q', 'semantic', 'text',
    'key', 'value', 'url', 'title', 'windowId', 'action', 'snapshotId', 'itemId', 'tabIds', 'settings', 'ignore'];
  const deep = (d: number): unknown => (d === 0 ? 'x' : [deep(d - 1)]);
  const JUNK: unknown[] = [
    null, undefined, true, -1, 0, 1e308, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53 + 1, '', ' ', 'x'.repeat(1 << 20),
    'javascript:alert(1)', 'chrome://settings', '__proto__', 'constructor', [], [null], ['x'.repeat(5000)],
    Array.from({ length: 100_000 }, (_, i) => String(i)), {}, JSON.parse('{"__proto__":{"polluted":1}}'),
    { toString: 'x', valueOf: 1 }, deep(2000), '{"format":"tab-organizer","version":1,"items":[{"__proto__":{"polluted":1}}]}',
  ];
  let seed = 7;
  const rnd = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n);
  function payloads(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [{}];
    for (let k = 0; k < 30; k++) {
      const p: Record<string, unknown> = {};
      for (let f = 1 + rnd(4); f > 0; f--) p[FIELDS[rnd(FIELDS.length)]!] = JUNK[rnd(JUNK.length)];
      out.push(p);
    }
    return out;
  }
  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchSpy);
    mock = installChromeMock({ windows: [{ tabs: [{ url: 'https://example.com/a', title: 'A' }, { url: 'https://example.org/b', title: 'B' }] }] });
    bg = await import('../../src/background/index');
    await bg.getDb();
  });
  afterAll(() => {
    mock.uninstall();
    vi.unstubAllGlobals();
  });
  it('finds the request types', () => expect(types.length).toBeGreaterThan(25));
  it('each settles within 5 s with a result or an Error; no prototype pollution; the database still works; no network', async () => {
    const hung: string[] = [];
    const nonErrors: string[] = [];
    const tally = { ok: 0, error: 0 };
    for (const t of types) {
      for (const p of payloads()) {
        const call = Promise.resolve().then(() => bg.handleRequest({ ...p, t } as never));
        const outcome = await Promise.race([
          call.then(() => 'ok', (e: unknown) => (e instanceof Error ? 'error' : `non-Error rejection: ${String(e).slice(0, 60)}`)),
          new Promise<string>((r) => setTimeout(() => r('hung'), 5000)),
        ]);
        if (outcome === 'ok' || outcome === 'error') tally[outcome]++;
        if (outcome === 'hung') hung.push(`${t} ${JSON.stringify(Object.keys(p))}`);
        else if (outcome.startsWith('non-Error')) nonErrors.push(`${t}: ${outcome}`);
      }
    }
    expect(hung).toEqual([]);
    expect(tally.ok + tally.error).toBe(types.length * 31); // every call settled
    expect(tally.error).toBeGreaterThan(types.length * 10); // most hostile payloads are refused by validation
    expect(tally.ok).toBeGreaterThan(0);
    expect(nonErrors).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    const state = (await bg.handleRequest({ t: 'state' } as never)) as { items: unknown[] };
    expect(Array.isArray(state.items)).toBe(true);
    const own = chrome.runtime.getURL('');
    expect(fetched.filter((u) => !u.startsWith(own))).toEqual([]);
  }, 300_000);
});
