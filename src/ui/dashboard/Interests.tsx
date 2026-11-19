import type { ComponentChildren } from 'preact';
import { useId, useMemo, useState } from 'preact/hooks';
import { INTEREST_CHOICES, STARTER_GROUPS } from '../../classify/seeds';
import { nameProblem } from '../../shared/names';
import type { GroupSummary } from '../../shared/types';
import { GroupDot } from '../common/GroupChip';
import { CheckIcon, CloseIcon, PlusIcon, SparkIcon } from '../common/icons';
import { Modal } from './Modal';

/** What "Add your own" says about a group it creates. */
export const CUSTOM_HELP = 'Learns from tabs you move into it.';
const COLOR = new Map(STARTER_GROUPS.map((g) => [g.id, g.color]));

/**
 * The choices the user already has a group for: by the choice's id, or by its name (any case, e.g. a built-in
 * group the user renamed). Suggestions are not groups yet.
 */
function haveChoices(groups: GroupSummary[]): { byId: Set<string>; byName: Set<string> } {
  const real = groups.filter((g) => !g.suggested);
  const ids = new Set(real.map((g) => g.id));
  const names = new Set(real.map((g) => g.name.toLowerCase()));
  const byId = new Set<string>();
  const byName = new Set<string>();
  for (const c of INTEREST_CHOICES) {
    if (ids.has(c.id)) byId.add(c.id);
    else if (names.has(c.name.toLowerCase())) byName.add(c.id);
  }
  return { byId, byName };
}

export interface InterestsAnswer { picked: string[]; custom: string[] }

/**
 * The picker's state. `lockExisting`: the choices the user already has show pressed and can't be unselected (the
 * answer only adds groups). Off for a fresh install's first answer: nothing is pressed, as the user's picks decide
 * which starter groups stay.
 */
function useInterests(groups: GroupSummary[], lockExisting: boolean) {
  const have = useMemo(() => haveChoices(groups), [groups]);
  const locked = useMemo(
    () => (lockExisting ? new Set([...have.byId, ...have.byName]) : new Set<string>()),
    [have, lockExisting],
  );
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [custom, setCustom] = useState<string[]>([]);
  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  /** Adds a custom name; returns the message to show when it is refused. */
  const add = (raw: string): string | null => {
    const problem = nameProblem(raw);
    if (problem) return problem;
    const name = raw.trim();
    const lower = name.toLowerCase();
    const choice = INTEREST_CHOICES.find((c) => c.name.toLowerCase() === lower);
    if (choice) {
      if (locked.has(choice.id)) return `You already have ${choice.name}.`;
      setPicked((p) => new Set(p).add(choice.id));
      return null;
    }
    if (groups.some((g) => !g.suggested && g.name.toLowerCase() === lower)) return `You already have a group called ${name}.`;
    if (!custom.some((c) => c.toLowerCase() === lower)) setCustom([...custom, name]);
    return null;
  };
  const remove = (name: string) => setCustom(custom.filter((c) => c !== name));
  const canContinue = picked.size > 0 || custom.length > 0;
  /**
   * The answer, in the choices' order. With existing groups locked, the ones held under their own id go along:
   * already there, they add nothing, and picked they can never be dropped as unpicked.
   */
  const answer = (): InterestsAnswer => ({
    picked: INTEREST_CHOICES.filter((c) => picked.has(c.id) || (lockExisting && have.byId.has(c.id))).map((c) => c.id),
    custom,
  });
  return { picked, locked, custom, toggle, add, remove, canContinue, answer };
}
type InterestsState = ReturnType<typeof useInterests>;

/** What a locked chip means, said once under the chips (and read with each locked chip). */
export const LOCKED_NOTE = 'Groups you already have are checked and stay as they are.';
/** The topic chips and "Add your own". They only change the picker's own state, so a running action leaves them on. */
function InterestsChoices({ s }: { s: InterestsState }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const noteId = useId();
  const fieldId = useId();
  const helpId = useId();
  const errorId = useId();
  const add = () => {
    const problem = s.add(draft);
    setError(problem);
    if (!problem) setDraft('');
  };
  return (
    <div class="interests">
      <div role="group" aria-label="Topics">
        <ul class="interest-chips">
          {INTEREST_CHOICES.map((c) => {
            const locked = s.locked.has(c.id);
            return (
              <li key={c.id}>
                <button
                  type="button" class="interest-chip" aria-pressed={locked || s.picked.has(c.id)} disabled={locked}
                  aria-describedby={locked ? noteId : undefined} onClick={() => s.toggle(c.id)}
                >
                  <GroupDot color={COLOR.get(c.id) ?? ''} />
                  {c.name}
                  {(locked || s.picked.has(c.id)) && <CheckIcon size={12} class="interest-check" />}
                </button>
              </li>
            );
          })}
          {s.custom.map((name) => (
            <li key={`custom:${name}`}>
              <span class="interest-chip is-custom">
                {name}
                <button
                  type="button" class="interest-chip-x" aria-label={`Remove ${name}`} title="Remove"
                  onClick={() => s.remove(name)}
                >
                  <CloseIcon size={12} />
                </button>
              </span>
            </li>
          ))}
        </ul>
        {s.locked.size > 0 && <p class="interest-help interest-locked" id={noteId}>{LOCKED_NOTE}</p>}
      </div>
      <div class="interest-add">
        <label class="interest-add-label" for={fieldId}>Add your own</label>
        <div class="interest-add-row">
          <input
            id={fieldId} class="field field-sm" value={draft} spellcheck={false} autocomplete="off"
            placeholder="A topic, e.g. Woodworking" aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${helpId} ${errorId}` : helpId}
            onInput={(e) => {
              setDraft(e.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              add();
            }}
          />
          <button type="button" class="btn btn-sm" onClick={add}><PlusIcon />Add</button>
        </div>
        <p class="interest-help" id={helpId}>{CUSTOM_HELP}</p>
        {error && <p class="interest-error" id={errorId} role="alert">{error}</p>}
      </div>
    </div>
  );
}

export interface InterestsCardProps {
  groups: GroupSummary[];
  /** See useInterests. */
  lockExisting: boolean;
  busy: boolean;
  onContinue: (a: InterestsAnswer) => void;
  onSkip: () => void;
}

/** The interests step as a card above the list: a fresh install's first screen, or the one-time card after an update. */
export function InterestsCard(props: InterestsCardProps & { title: string; intro: ComponentChildren; icon?: ComponentChildren }) {
  const s = useInterests(props.groups, props.lockExisting);
  const titleId = useId();
  return (
    <section class="card interests-card" aria-labelledby={titleId}>
      {props.icon ?? <SparkIcon class="card-icon" />}
      <div class="card-text">
        <h2 id={titleId} class="card-title">{props.title}</h2>
        <p class="interests-intro">{props.intro}</p>
        <InterestsChoices s={s} />
        <div class="card-actions">
          <button
            type="button" class="btn btn-sm btn-primary" disabled={props.busy || !s.canContinue}
            onClick={() => props.onContinue(s.answer())}
          >
            Continue
          </button>
          <button type="button" class="btn btn-sm" disabled={props.busy} onClick={props.onSkip}>Skip</button>
        </div>
      </div>
    </section>
  );
}

/** Settings → General → "Choose your interests": the same step in a dialog. It only adds groups. */
export function InterestsDialog(props: { groups: GroupSummary[]; busy: boolean; onContinue: (a: InterestsAnswer) => void; onClose: () => void }) {
  const s = useInterests(props.groups, true);
  return (
    <Modal
      title="Choose your interests" onClose={props.onClose} wide
      footer={
        <>
          <button type="button" class="btn" onClick={props.onClose}>Cancel</button>
          <button type="button" class="btn btn-primary" disabled={props.busy || !s.canContinue} onClick={() => props.onContinue(s.answer())}>
            Continue
          </button>
        </>
      }
    >
      <p>What do you browse most? Tablight adds a group for each topic you pick. Groups you already have stay as they are.</p>
      <InterestsChoices s={s} />
    </Modal>
  );
}
