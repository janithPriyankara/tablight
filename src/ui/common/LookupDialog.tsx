// The opt-in look-up's only door (design Part 2): the "Look it up" button on Unsorted rows and the confirm dialog it
// opens. This is the one module allowed to import the look-up client (LOOKUP_IMPORTERS in
// scripts/release-patterns.mjs), and lookUp is called in exactly one place: the dialog's "Look up" click handler.
// Nothing is sent before that click; what is sent is the text shown in the box, cleaned again.
import { useId, useState } from 'preact/hooks';
import { INTEREST_CHOICES } from '../../classify/seeds';
import { cleanLookupText, lookupText } from '../../shared/lookup-text';
import { send } from '../../shared/rpc';
import type { Item } from '../../shared/types';
import { Modal } from '../dashboard/Modal';
import { LOOKUP_DIALOG_SENTENCE, lookUp, type LookupError, type LookupHit } from './lookup';
import { displayTitle } from './format';
import { GlobeIcon } from './icons';

/** The hint under the setting's toggle (Settings → General). */
export const LOOKUP_SETTING_HINT = 'Sends only the text you confirm, to Wikidata. Nothing is sent unless you click.';
const NEVER_SENT = 'Never sent: the page address, your other tabs, cookies, or any ID.';
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
  | { k: 'hits'; hits: LookupHit[] }
  | { k: 'error'; error: LookupError }
  | { k: 'moving' }
  | { k: 'moveFailed' };

/** A starter group's name by id (the groups the interests step can create). */
const starterName = (id: string): string | null => INTEREST_CHOICES.find((c) => c.id === id)?.name ?? null;

/**
 * The confirm dialog, shown every time: the sentence, the editable cleaned text, what is never sent, Wikimedia's
 * privacy policy, Look up / Cancel. Hits are plain text. "Move to" is the user's own move (it teaches the group);
 * a hit whose topic group does not exist offers to create that starter group first. After a move it closes.
 */
export function LookupDialog(props: {
  item: Item;
  /** The groups that exist (suggestions excluded by the caller or here). */
  groups: ReadonlyArray<{ id: string; name: string; suggested?: boolean }>;
  onClose: () => void;
}) {
  const { item, onClose } = props;
  const groups = props.groups.filter((g) => !g.suggested);
  const [text, setText] = useState(() => lookupOffer({ ...item, groupId: null }) ?? '');
  const [phase, setPhase] = useState<Phase>({ k: 'edit' });
  const boxId = useId();
  const clean = cleanLookupText(text);
  const busy = phase.k === 'busy' || phase.k === 'moving';

  const onLookUp = async () => {
    const sent = cleanLookupText(text);
    if (!sent || busy) return;
    setText(sent); // the box shows exactly what is sent
    setPhase({ k: 'busy' });
    const r = await lookUp(sent, { groups });
    setPhase('error' in r ? { k: 'error', error: r.error } : { k: 'hits', hits: r.hits });
  };
  const move = async (hit: LookupHit) => {
    const groupId = hit.group ?? hit.topic;
    if (groupId === null) return;
    setPhase({ k: 'moving' });
    try {
      if (hit.group === null) {
        // Creates the starter group (the interests path). Every existing group is listed too, so even a first answer
        // on a fresh install removes nothing.
        await send({ t: 'interests', picked: [groupId, ...groups.map((g) => g.id)], custom: [] });
      }
      await send({ t: 'moveItems', ids: [item.id], groupId });
      onClose();
    } catch {
      setPhase({ k: 'moveFailed' });
    }
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
    <Modal title="Look it up" onClose={onClose}>
      <p class="lookup-for">{displayTitle(item)}</p>
      <label class="lookup-label" for={boxId}>{LOOKUP_DIALOG_SENTENCE}</label>
      <input
        id={boxId} class="field lookup-text" value={text} maxLength={200} spellcheck={false} autocomplete="off" data-autofocus
        disabled={busy}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void onLookUp();
          }
        }}
      />
      <p class="lookup-note">{NEVER_SENT}</p>
      <p class="lookup-note">
        <a class="link" href={PRIVACY_POLICY} target="_blank" rel="noopener noreferrer">Wikimedia’s privacy policy</a>
      </p>
      <div class="lookup-buttons">
        <button type="button" class="btn" onClick={onClose}>Cancel</button>
        <button type="button" class="btn btn-primary" disabled={!clean || busy} onClick={() => void onLookUp()}>Look up</button>
      </div>
      <div class="lookup-result" role="status" aria-live="polite">
        {phase.k === 'busy' && <p>Looking up…</p>}
        {phase.k === 'moving' && <p>Moving…</p>}
        {phase.k === 'moveFailed' && <p>Couldn’t move the tab.</p>}
        {phase.k === 'error' && phase.error === 'offline' && <p>You seem to be offline.</p>}
        {phase.k === 'error' && phase.error === 'timeout' && <p>Wikidata didn't answer in time.</p>}
        {phase.k === 'error' && phase.error === 'http' && <p>Wikidata returned an error.</p>}
        {phase.k === 'error' && phase.error === 'bad-reply' && <p>Couldn't read Wikidata's answer.</p>}
        {phase.k === 'hits' && phase.hits.length === 0 && <p>No matches</p>}
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
