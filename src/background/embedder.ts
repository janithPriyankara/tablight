import { send } from '../shared/rpc.ts';
const BATCH = 32;
const IDLE_MS = 60_000;
let creating: Promise<void> | undefined;
let inflight = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
async function ensureDocument(): Promise<void> {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS' as chrome.offscreen.Reason],
    justification: 'Run the on-device embedding model',
  });
}
function ensureOnce(): Promise<void> {
  creating ??= ensureDocument().catch((e: unknown) => {
    creating = undefined;
    throw e;
  });
  return creating;
}
function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (inflight > 0) return;
    creating = undefined;
    void chrome.offscreen.closeDocument().catch(() => undefined);
  }, IDLE_MS);
}
export async function embed(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  inflight++;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  try {
    await ensureOnce();
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const rows = await send<number[][]>({ t: 'embed', texts: texts.slice(i, i + BATCH) });
      for (const r of rows) out.push(Float32Array.from(r));
    }
    return out;
  } finally {
    inflight--;
    if (inflight === 0) scheduleIdleClose();
  }
}
