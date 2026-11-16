import { send } from '../shared/rpc.ts';
const BATCH = 32;
/**
 * Idle close. A setTimeout in the service worker can't do it: MV3 kills an idle worker after ~30 s, long
 * before a 60 s timer fires, so the model would stay loaded. A one-shot alarm survives the worker and wakes
 * it; the offscreen document also runs its own idle timer and asks for the close (`offscreenIdle`).
 */
export const OFFSCREEN_IDLE_ALARM = 'offscreen-idle';
let ensuring: Promise<void> | undefined; // shared only while a check/create is pending
let closing: Promise<void> | undefined;
let inflight = 0;
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
  // Re-creating a named alarm replaces it: each finished embed pushes the close back by a minute.
  void Promise.resolve(chrome.alarms.create(OFFSCREEN_IDLE_ALARM, { delayInMinutes: 1 })).catch(() => undefined);
}
/**
 * Closes the offscreen document when nothing is in flight (from the idle alarm or the document's own idle
 * request). A call that starts later re-creates the document. Never rejects.
 */
export async function closeIfIdle(): Promise<void> {
  if (inflight > 0 || closing || ensuring) return; // the running call re-arms the alarm when it ends
  const open = await chrome.runtime
    .getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] })
    .catch(() => [{}]);
  if (open.length === 0 || inflight > 0 || closing || ensuring) return;
  closing = chrome.offscreen
    .closeDocument()
    .catch(() => undefined)
    .finally(() => {
      closing = undefined;
    });
  await closing;
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
