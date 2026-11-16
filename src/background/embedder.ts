import { send } from '../shared/rpc.ts';
const BATCH = 32;
const IDLE_MS = 60_000;
let ensuring: Promise<void> | undefined; // shared only while a check/create is pending
let closing: Promise<void> | undefined;
let inflight = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let warm = false;
/** True once the model produced at least one vector in this worker's lifetime. */
export function isWarm(): boolean {
  return warm;
}
async function ensureDocument(): Promise<void> {
  if (closing) await closing; // never race a close in progress
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS' as chrome.offscreen.Reason],
    justification: 'Run the on-device embedding model',
  });
}
// Always re-checks getContexts, so a document that died for any reason is recreated.
function ensureOnce(): Promise<void> {
  ensuring ??= ensureDocument().finally(() => {
    ensuring = undefined;
  });
  return ensuring;
}
function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (inflight > 0) return;
    closing = chrome.offscreen
      .closeDocument()
      .catch(() => undefined)
      .finally(() => {
        closing = undefined;
      });
  }, IDLE_MS);
}
async function sendBatch(texts: string[]): Promise<number[][]> {
  try {
    return await send<number[][]>({ t: 'embed', texts });
  } catch {
    // The document may have died (reclaimed, crashed): re-ensure and retry once.
    await ensureOnce();
    return send<number[][]>({ t: 'embed', texts });
  }
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
      const rows = await sendBatch(texts.slice(i, i + BATCH));
      for (const r of rows) out.push(Float32Array.from(r));
      if (rows.length > 0) warm = true;
    }
    return out;
  } finally {
    inflight--;
    if (inflight === 0) scheduleIdleClose();
  }
}
