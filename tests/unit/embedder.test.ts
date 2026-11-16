import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
type Listener = (m: unknown, s: unknown, r: (x: unknown) => void) => boolean | undefined;
let listener: Listener | undefined;
let docExists = false;
const createDocument = vi.fn(async () => {
  await Promise.resolve();
  docExists = true;
});
const closeDocument = vi.fn(async () => {
  docExists = false;
});
const sendMessage = vi.fn(async (m: { texts: string[] }) => ({
  ok: true,
  data: m.texts.map((t) => [Number(t), 0]),
}));
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  docExists = false;
  listener = undefined;
  createDocument.mockClear();
  closeDocument.mockClear();
  sendMessage.mockClear();
  vi.stubGlobal('chrome', {
    offscreen: { createDocument, closeDocument },
    runtime: {
      id: 'me',
      getURL: (p: string) => `chrome-extension://me/${p}`,
      getContexts: async () => (docExists ? [{}] : []),
      sendMessage,
      onMessage: { addListener: (l: Listener) => (listener = l) },
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('embedder', () => {
  it('creates the offscreen document once with WORKERS', async () => {
    const { embed } = await import('../../src/background/embedder.ts');
    await embed(['1']);
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(createDocument).toHaveBeenCalledWith(
      expect.objectContaining({ reasons: ['WORKERS'], url: 'offscreen.html' }),
    );
  });
  it('shares one createDocument across concurrent calls', async () => {
    const { embed } = await import('../../src/background/embedder.ts');
    await Promise.all([embed(['1']), embed(['2'])]);
    expect(createDocument).toHaveBeenCalledTimes(1);
  });
  it('closes the document after 60 s idle', async () => {
    const { embed } = await import('../../src/background/embedder.ts');
    await embed(['1']);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(closeDocument).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(closeDocument).toHaveBeenCalledTimes(1);
  });
  it('batches 70 texts as 32/32/6 and keeps order', async () => {
    const { embed } = await import('../../src/background/embedder.ts');
    const texts = Array.from({ length: 70 }, (_, i) => String(i));
    const out = await embed(texts);
    expect(sendMessage.mock.calls.map((c) => c[0].texts.length)).toEqual([32, 32, 6]);
    expect(out.map((v) => v[0])).toEqual(texts.map(Number));
    expect(out[0]).toBeInstanceOf(Float32Array);
  });
  it('skips createDocument when one already exists', async () => {
    docExists = true;
    const { embed } = await import('../../src/background/embedder.ts');
    await embed(['1']);
    expect(createDocument).not.toHaveBeenCalled();
  });
});
describe('rpc handle', () => {
  async function setup() {
    const { handle } = await import('../../src/shared/rpc.ts');
    const h = vi.fn(async () => 'done');
    handle(h);
    return h;
  }
  const good = { id: 'me', url: 'chrome-extension://me/dashboard.html' };
  it('answers a valid message from our own page', async () => {
    const h = await setup();
    const respond = vi.fn();
    expect(listener?.({ t: 'snapshotNow' }, good, respond)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({ ok: true, data: 'done' });
  });
  it('ignores foreign senders, unknown types and offscreen-targeted messages', async () => {
    const h = await setup();
    const respond = vi.fn();
    expect(listener?.({ t: 'snapshotNow' }, { id: 'evil' }, respond)).toBe(false);
    expect(listener?.({ t: 'snapshotNow' }, { id: 'me', url: 'https://evil.example/' }, respond)).toBe(false);
    expect(listener?.({ t: 'nope' }, good, respond)).toBe(false);
    expect(listener?.({ t: 'embed', texts: [], target: 'offscreen' }, good, respond)).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });
});
describe('embedder lifecycle', () => {
  it('re-opens after an idle close', async () => {
    const { embed } = await import('../../src/background/embedder.ts');
    await embed(['1']);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(closeDocument).toHaveBeenCalledTimes(1);
    await embed(['2']);
    expect(createDocument).toHaveBeenCalledTimes(2);
  });
  it('recreates a document that died and retries once', async () => {
    const { embed } = await import('../../src/background/embedder.ts');
    await embed(['1']);
    docExists = false; // reclaimed by the browser
    sendMessage.mockRejectedValueOnce(new Error('Could not establish connection'));
    const out = await embed(['7']);
    expect(createDocument).toHaveBeenCalledTimes(2);
    expect(out[0]?.[0]).toBe(7);
  });
  it('does not close while a call is in flight and waits for close before reopening', async () => {
    let release!: () => void;
    closeDocument.mockImplementationOnce(
      () => new Promise<void>((r) => (release = () => { docExists = false; r(); })),
    );
    const { embed } = await import('../../src/background/embedder.ts');
    await embed(['1']);
    await vi.advanceTimersByTimeAsync(60_500); // close started, pending
    const p = embed(['2']);
    await vi.advanceTimersByTimeAsync(10);
    expect(createDocument).toHaveBeenCalledTimes(1); // waiting on the close
    release();
    await p;
    expect(createDocument).toHaveBeenCalledTimes(2);
  });
  it('no idle close while a slow call is running', async () => {
    let finish!: () => void;
    sendMessage.mockImplementationOnce(
      () => new Promise((r) => (finish = () => r({ ok: true, data: [[1, 0]] }))),
    );
    const { embed } = await import('../../src/background/embedder.ts');
    const p = embed(['1']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(closeDocument).not.toHaveBeenCalled();
    finish();
    await p;
  });
});
