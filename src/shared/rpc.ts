import type { Settings } from './types.ts';
// One discriminated union for every UI<->background and background<->offscreen message.
export type Req =
  | { t: 'embed'; texts: string[] } // background -> offscreen
  | { t: 'state' } // ui -> bg: returns DashboardState
  | { t: 'search'; q: string; semantic: boolean }
  | { t: 'moveItems'; ids: string[]; groupId: string }
  | { t: 'sleep'; ids: string[] }
  | { t: 'stash'; ids: string[] }
  | { t: 'open'; id: string }
  | { t: 'close'; ids: string[] }
  | { t: 'closeExtras' }
  | { t: 'undo'; token: string }
  | { t: 'groupCreate'; name: string; ids: string[] }
  | { t: 'groupRename'; id: string; name: string }
  | { t: 'groupMerge'; from: string; into: string }
  | { t: 'groupDelete'; id: string }
  | { t: 'acceptSuggestion'; id: string }
  | { t: 'dismissSuggestion'; id: string }
  | { t: 'regroupPreview' }
  | { t: 'regroupApply' }
  | { t: 'snapshotNow' }
  | { t: 'sessionAction'; id: string; action: 'openAll' | 'stashAll' | 'delete' }
  | { t: 'settings'; patch: Partial<Settings> }
  | { t: 'export' }
  | { t: 'import'; json: string };
export type ReqType = Req['t'];
export type Target = 'background' | 'offscreen';
const REQ_TYPES: ReadonlySet<string> = new Set<ReqType>([
  'embed', 'state', 'search', 'moveItems', 'sleep', 'stash', 'open', 'close', 'closeExtras',
  'undo', 'groupCreate', 'groupRename', 'groupMerge', 'groupDelete', 'acceptSuggestion',
  'dismissSuggestion', 'regroupPreview', 'regroupApply', 'snapshotNow', 'sessionAction', 'settings', 'export', 'import',
]);
// chrome.runtime.sendMessage broadcasts to every extension page, so the envelope names its receiver.
export type Envelope = Req & { target?: Target };
export type Reply = { ok: true; data: unknown } | { ok: false; error: string };
export async function send<R>(req: Req, target?: Target): Promise<R> {
  const to: Target = target ?? (req.t === 'embed' ? 'offscreen' : 'background');
  const envelope: Envelope = { ...req, target: to };
  const reply = (await chrome.runtime.sendMessage(envelope)) as Reply | undefined;
  if (!reply) throw new Error(`no response for "${req.t}"`);
  if (!reply.ok) throw new Error(reply.error);
  return reply.data as R;
}
function senderAllowed(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  // Extension pages opened as tabs carry sender.tab; their url is still ours. Anything else is rejected.
  if (sender.url !== undefined && !sender.url.startsWith(chrome.runtime.getURL(''))) return false;
  return true;
}
export function handle(
  h: (req: Req, sender: chrome.runtime.MessageSender) => Promise<unknown>,
  target: Target = 'background',
): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (typeof message !== 'object' || message === null) return false;
    const m = message as { t?: unknown; target?: unknown };
    if (typeof m.t !== 'string' || !REQ_TYPES.has(m.t)) return false;
    if ((m.target ?? 'background') !== target) return false;
    if (!senderAllowed(sender)) return false;
    const { target: _ignored, ...req } = message as Envelope;
    void _ignored;
    h(req as Req, sender).then(
      (data) => sendResponse({ ok: true, data } satisfies Reply),
      (e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies Reply),
    );
    return true;
  });
}
