/**
 * Raw DevTools network capture for the extension's offscreen document, which Playwright never attaches
 * to (CDP lists it as "background_page"; it is born as an untyped "other" target), so its requests
 * never reach context.on('request'). The browser runs with --remote-debugging-port=0; this opens a second connection, auto-attaches to
 * those target types with waitForDebuggerOnStart (flat sessions, which Playwright's CDPSession cannot
 * address, hence the raw socket), enables Network in each and only then lets it run, so a new target
 * cannot send a request before it is recorded.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'undici';
export interface CapturedRequest {
  /** CDP target type at attach time: 'background_page', or 'other' for a just-created offscreen document. */
  targetType: string;
  url: string;
}
export interface NetworkCapture {
  /** Every request the attached targets sent since they were attached. */
  requests: CapturedRequest[];
  /** Attached targets by type at attach time. */
  attached: Map<string, number>;
  close: () => void;
}
async function devtoolsEndpoint(userDataDir: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const text = await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8').catch(() => '');
    const [port, path] = text.split('\n');
    if (port && path) return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('DevToolsActivePort did not appear (is --remote-debugging-port=0 set?)');
}
export async function captureNetwork(userDataDir: string): Promise<NetworkCapture> {
  const ws = new WebSocket(await devtoolsEndpoint(userDataDir));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('DevTools connection failed')), { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const send = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const sessions = new Map<string, string>(); // sessionId -> target type
  const out: NetworkCapture = { requests: [], attached: new Map(), close: () => ws.close() };
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      id?: number; error?: { message: string }; result?: unknown; method?: string; sessionId?: string;
      params?: Record<string, unknown>;
    };
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
      return;
    }
    if (msg.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = msg.params as { sessionId: string; targetInfo: { type: string } };
      sessions.set(sessionId, targetInfo.type);
      out.attached.set(targetInfo.type, (out.attached.get(targetInfo.type) ?? 0) + 1);
      void send('Network.enable', {}, sessionId)
        .finally(() => send('Runtime.runIfWaitingForDebugger', {}, sessionId))
        .catch(() => undefined); // the target may already be gone
    }
    if (msg.method === 'Network.requestWillBeSent') {
      out.requests.push({
        targetType: sessions.get(msg.sessionId ?? '') ?? 'unknown',
        url: (msg.params as { request: { url: string } }).request.url,
      });
    }
  });
  await send('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: 'background_page', exclude: false }, { type: 'other', exclude: false }, { exclude: true }],
  });
  return out;
}
