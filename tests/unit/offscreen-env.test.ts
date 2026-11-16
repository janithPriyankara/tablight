import { beforeEach, describe, expect, it, vi } from 'vitest';
describe('offscreen env', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'me',
        getURL: (p: string) => `chrome-extension://me/${p}`,
        onMessage: { addListener: vi.fn() },
      },
    });
  });
  async function load(wasm: object | undefined) {
    const env = { backends: { onnx: { wasm } } } as Record<string, unknown>;
    const snap: Record<string, unknown>[] = [];
    const pipeline = vi.fn(async () => {
      snap.push(JSON.parse(JSON.stringify(env)));
      return async () => ({ tolist: () => [] });
    });
    vi.doMock('@huggingface/transformers', () => ({ env, pipeline }));
    return { env, pipeline, snap };
  }
  it('sets every no-network option before the first pipeline() call', async () => {
    const wasm = {};
    const { env, pipeline, snap } = await load(wasm);
    let listener: ((m: unknown, s: unknown, r: (x: unknown) => void) => unknown) | undefined;
    (chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>).mockImplementation((l) => (listener = l));
    await import('../../src/offscreen/offscreen.ts');
    expect(pipeline).not.toHaveBeenCalled();
    const respond = vi.fn();
    listener?.({ t: 'embed', texts: ['a'], target: 'offscreen' }, { id: 'me' }, respond);
    await vi.waitFor(() => expect(pipeline).toHaveBeenCalledTimes(1));
    const s = snap[0] as Record<string, unknown> & { backends: { onnx: { wasm: Record<string, unknown> } } };
    expect(s).toMatchObject({
      allowRemoteModels: false,
      allowLocalModels: true,
      localModelPath: 'chrome-extension://me/models/',
      useBrowserCache: false,
      useWasmCache: false,
    });
    expect(s.backends.onnx.wasm).toMatchObject({
      numThreads: 1,
      proxy: false,
      wasmPaths: {
        mjs: 'chrome-extension://me/ort/ort-wasm-simd-threaded.mjs',
        wasm: 'chrome-extension://me/ort/ort-wasm-simd-threaded.wasm',
      },
    });
    expect(env).toBeDefined();
  });
  it('fails closed when the wasm backend env is missing', async () => {
    await load(undefined);
    await expect(import('../../src/offscreen/offscreen.ts')).rejects.toThrow(/CDN/);
  });
});
