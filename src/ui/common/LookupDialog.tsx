// The opt-in look-up's only door (design Part 2): the "Look it up" button on Unsorted rows and the confirm dialog it
// opens. This is the one module allowed to import the look-up client (LOOKUP_IMPORTERS in
// scripts/release-patterns.mjs), and lookUp is called in exactly one place: the dialog's "Look up" click handler.
// Nothing is sent before that click; what is sent is the text shown in the box, cleaned again.
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { INTEREST_CHOICES } from '../../classify/seeds';
import { cleanLookupText, lookupText } from '../../shared/lookup-text';
import { send } from '../../shared/rpc';
import type { Item } from '../../shared/types';
import { Modal } from '../dashboard/Modal';
import { LOOKUP_DIALOG_SENTENCE, lookUp, type LookupFailure, type LookupHit } from './lookup';
import { GlobeIcon } from './icons';

/** The hint under the setting's toggle (Settings → General). */
export const LOOKUP_SETTING_HINT =
  'Sends only the text you confirm, to Wikidata (and to Wikipedia if Wikidata has no usable match). Nothing is sent unless you click.';
const NEVER_SENT = 'Never sent: the page address, your other tabs or cookies. Wikimedia sees your IP address, as any website does.';
const PRIVACY_POLICY = 'https://foundation.wikimedia.org/wiki/Policy:Privacy_policy';

/** The text a row may offer for look-up, or null: only Unsorted rows, and never a refused tab (local, sensitive…). */
export function lookupOffer(item: Item): string | null {
  if (item.groupId !== null) return null;
  const r = lookupText(item.url, item.title);
  return 'text' in r ? r.text : null;
}

/** The row action. The caller shows it only when the setting is on and lookupOffer(item) is not null. */
export function LookItUpButton(props: { item: Item; onClick: (item: Item) => void; tabIndex?: number; disabled?: boolean }) {
  return (
    <button
      type="button" class="icon-btn" tabIndex={props.tabIndex} disabled={props.disabled} aria-label="Look it up"
      title="Look it up: asks a public encyclopedia what this is (you confirm the text first)"
      onClick={() => props.onClick(props.item)}
    >
      <GlobeIcon />
    </button>
  );
}

type Phase =
  | { k: 'edit' }
  | { k: 'busy' }
  | { k: 'hits'; hits: LookupHit[]; wikipediaFailed: boolean }
  | { k: 'error'; error: LookupFailure['error']; wikipedia: boolean }
  | { k: 'moving' }
  | { k: 'moveFailed' }
  | { k: 'gone' };

/** A site's name, as JSX text (the release gate allows the word Wikidata here only as prose, never in a string). */
const Site = (p: { wikipedia: boolean }) => (p.wikipedia ? <>Wikipedia</> : <>Wikidata</>);
/** A starter group's name by id (the groups the interests step can create). */
const starterName = (id: string): string | null => INTEREST_CHOICES.find((c) => c.id === id)?.name ?? null;

/**
 * The confirm dialog, shown every time: the sentence, the editable cleaned text, what is never sent, Wikimedia's
 * privacy policy, Look up / Cancel. Only activating the "Look up" button sends (Enter in the box does nothing, so a
 * held or repeated Enter from the row button, or an IME's confirming Enter, can never send). Hits are plain text,
 * each tagged with the site it came from (Wikidata, or Wikipedia when Wikidata found nothing).
 * "Move to" is the user's own move (it teaches the group); a hit whose topic group does not exist offers to create
 * that one starter group first (groupCreateStarter: no other effect). After a move it closes.
 */
export function LookupDialog(props: {
  item: Item;
  /** The groups that exist (suggestions excluded by the caller or here). */
  groups: ReadonlyArray<{ id: string; name: string; suggested?: boolean }>;
  /** `moved`: the tab was moved (its row may be about to leave the list the dialog was opened from). */
  onClose: (moved?: boolean) => void;
}) {
  const { item, onClose } = props;
  const groups = props.groups.filter((g) => !g.suggested);
  const [text, setText] = useState(() => lookupOffer({ ...item, groupId: null }) ?? '');
  const [phase, setPhase] = useState<Phase>({ k: 'edit' });
  const boxId = useId();
  const clean = cleanLookupText(text);
  const busy = phase.k === 'busy' || phase.k === 'moving';
  /** A move in flight: the dialog cannot be cancelled until it settles (the move would still happen). */
  const moving = useRef(false);
  const mounted = useRef(true);
  /** Aborted on Cancel, Escape or unmount: a look-up still running sends nothing more (no Wikipedia fallback). */
  const stop = useRef<AbortController | null>(null);
  // A layout effect: registered as soon as the dialog renders, so even an unmount right after "Look up" aborts.
  useLayoutEffect(() => () => {
    mounted.current = false;
    stop.current?.abort();
  }, []);
  const cancel = () => {
    if (moving.current) return;
    stop.current?.abort();
    onClose(false);
  };

  const onLookUp = async () => {
    const sent = cleanLookupText(text);
    if (!sent || busy) return;
    setText(sent); // the box shows exactly what is sent (and the "Will send" line already showed it)
    setPhase({ k: 'busy' });
    const c = new AbortController();
    stop.current = c;
    const r = await lookUp(sent, { groups, signal: c.signal });
    if (!mounted.current || c.signal.aborted) return;
    if ('error' in r) setPhase({ k: 'error', error: r.error, wikipedia: r.from === 'wikipedia' });
    else setPhase({ k: 'hits', hits: r.hits, wikipediaFailed: r.wikipediaFailed === true });
  };
  const move = async (hit: LookupHit) => {
    if (hit.group === null && hit.topic === null) return;
    moving.current = true;
    setPhase({ k: 'moving' });
    let next: Phase | null = null;
    try {
      // A missing starter group is created first: that one group, nothing else (a same-named user group is reused).
      const groupId = hit.group ?? (await send<string>({ t: 'groupCreateStarter', id: hit.topic! }));
      const moved = await send<number>({ t: 'moveItems', ids: [item.id], groupId });
      if (moved === 0) next = { k: 'gone' };
    } catch {
      next = { k: 'moveFailed' };
    }
    moving.current = false;
    if (!mounted.current) return;
    if (next) setPhase(next);
    else onClose(true);
  };
  const actionFor = (hit: LookupHit) => {
    if (hit.group !== null) {
      const name = groups.find((g) => g.id === hit.group)?.name;
      return name ? `Move to ${name}` : null;
    }
    const name = hit.topic !== null ? starterName(hit.topic) : null;
    return name ? `Create ${name} and move` : null;
  };

  return (
    <Modal title="Look it up" onClose={cancel}>
      <label class="lookup-label" for={boxId}>{LOOKUP_DIALOG_SENTENCE}</label>
      <input
        id={boxId} class="field lookup-text" value={text} maxLength={200} spellcheck={false} autocomplete="off" data-autofocus
        disabled={busy}
        onInput={(e) => {
          setText(e.currentTarget.value);
          if (phase.k !== 'edit') setPhase({ k: 'edit' }); // old hits never sit next to new text
        }}
        // Enter never sends: only the "Look up" button does. An IME's Enter (it commits the composition) is left alone.
        onKeyDown={(e) => e.key === 'Enter' && !e.isComposing && e.preventDefault()}
      />
      {clean !== text && <p class="lookup-note lookup-will-send">{clean ? `Will send: ${clean}` : 'Nothing is left to send.'}</p>}
      <p class="lookup-note">{NEVER_SENT}</p>
      <p class="lookup-note">
        <a class="link" href={PRIVACY_POLICY} target="_blank" rel="noopener noreferrer">Wikimedia’s privacy policy</a>
      </p>
      <div class="lookup-buttons">
        <button type="button" class="btn" disabled={phase.k === 'moving'} onClick={cancel}>Cancel</button>
        <button type="button" class="btn btn-primary" disabled={!clean || busy} onClick={() => void onLookUp()}>Look up</button>
      </div>
      <div class="lookup-result" role="status" aria-live="polite">
        {phase.k === 'busy' && <p>Looking up…</p>}
        {phase.k === 'moving' && <p>Moving…</p>}
        {phase.k === 'moveFailed' && <p>Couldn’t move the tab.</p>}
        {phase.k === 'gone' && <p>That tab is no longer open.</p>}
        {phase.k === 'error' && phase.error === 'offline' && <p>You seem to be offline.</p>}
        {phase.k === 'error' && phase.error === 'timeout' && <p><Site wikipedia={phase.wikipedia} /> didn't answer in time.</p>}
        {phase.k === 'error' && phase.error === 'http' && <p><Site wikipedia={phase.wikipedia} /> returned an error.</p>}
        {phase.k === 'error' && phase.error === 'bad-reply' && <p>Couldn't read <Site wikipedia={phase.wikipedia} />'s answer.</p>}
        {phase.k === 'hits' && phase.hits.length === 0 && <p>No matches</p>}
        {phase.k === 'hits' && phase.wikipediaFailed && <p class="lookup-note">Wikipedia didn’t answer; these are Wikidata’s matches.</p>}
      </div>
      {phase.k === 'hits' && phase.hits.length > 0 && (
        <ul class="lookup-hits" aria-label="Matches">
          {phase.hits.map((hit, i) => {
            const action = actionFor(hit);
            return (
              <li key={i} class="lookup-hit">
                <span class="lookup-hit-text">
                  <span class="lookup-hit-label">{hit.label}</span>
                  {hit.description && <span class="lookup-hit-desc">{hit.description}</span>}
                  <span class="lookup-hit-source"><Site wikipedia={hit.source === 'wikipedia'} /></span>
                </span>
                {action && (
                  <button type="button" class="btn btn-sm" onClick={() => void move(hit)}>{action}</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
