import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

export interface TourStep {
  /** CSS selector of the real element this step points at; none (or not on screen) = a centred card. */
  target?: string;
  title: string;
  body: ComponentChildren;
}

/** The guided tour, in the order a new user meets things. Plain words, one idea per step. */
export const TOUR_STEPS: TourStep[] = [
  {
    title: 'Welcome to Tab Organizer',
    body: (
      <>
        <p>This short tour shows you around, using your own tabs.</p>
        <p class="tour-keys">Use <kbd>→</kbd> and <kbd>←</kbd> to move, <kbd>Esc</kbd> to stop. You can restart it any time with the <strong>?</strong> button at the top.</p>
      </>
    ),
  },
  {
    target: '[data-tour="groups"]',
    title: 'Your groups',
    body: (
      <>
        <p>Every tab from every window is sorted by topic here: AI, Movies, Shopping and so on.</p>
        <p>The sorting is done by a small AI model that runs on your computer. Nothing is sent anywhere. The number is how many tabs are in the group; <strong>▶ 3</strong> means 3 videos or shows to watch.</p>
      </>
    ),
  },
  {
    target: '[data-tour="all"]',
    title: 'All tabs',
    body: <p>All your tabs in one list, across all windows. Click any tab to jump straight to it, even in another window.</p>,
  },
  {
    target: '[data-tour="row"]',
    title: 'Each tab',
    body: (
      <>
        <p>Click a tab to switch to it. Hover it for its buttons:</p>
        <ul class="tour-list">
          <li><strong>⏸ Pause</strong>: frees its memory. It stays in your tab strip and comes back when you click it.</li>
          <li><strong>Save for later</strong>: closes it and keeps it in your Saved for later list.</li>
          <li><strong>Move</strong>: puts it in another group. <strong>✕</strong> closes it.</li>
        </ul>
      </>
    ),
  },
  {
    target: '[data-tour="groups"]',
    title: 'Teach it',
    body: (
      <>
        <p>Drag a tab onto a group to move it there. Select several with their checkboxes to move them together.</p>
        <p>Tab Organizer learns from this: similar tabs go to that group next time, on your other devices too when sync is on.</p>
      </>
    ),
  },
  {
    target: '[data-tour="unsorted"]',
    title: 'Unsorted and new topics',
    body: (
      <>
        <p>Tabs that don’t fit any group wait in Unsorted.</p>
        <p>When a few of them share a topic, a <strong>✨ suggested group</strong> appears under your groups. Accept it, or dismiss it. Settings can create these groups automatically.</p>
      </>
    ),
  },
  {
    target: '[data-tour="search"]',
    title: 'Search',
    body: <p>Type a few words to find any tab; typos are fine. It also finds tabs that are similar in meaning. Press <kbd>/</kbd> to jump here.</p>,
  },
  {
    target: '[data-tour="close-duplicates"]',
    title: 'Duplicates',
    body: <p>The same page open twice? <strong>Close duplicates</strong> keeps one copy and closes the rest. Every close can be undone for 10 seconds.</p>,
  },
  {
    target: '[data-tour="stashed"]',
    title: 'Saved for later',
    body: <p>Your reading list. Saved tabs use no memory, sync to your other devices, and open again with one click.</p>,
  },
  {
    target: '[data-tour="sessions"]',
    title: 'Pick up where you left off',
    body: <p>Every hour Tab Organizer remembers your windows. After a restart, or the next morning, open them all again or save them for later.</p>,
  },
  {
    title: 'Popup and side panel',
    body: (
      <>
        <p><strong>Toolbar icon</strong>: a quick popup with search and your top groups.</p>
        <p><strong>Side panel</strong> (<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>): stays open next to your pages, showing this window’s tabs and your groups.</p>
        <p><strong>This dashboard</strong>: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd>.</p>
        <p>Tip: pin Tab Organizer with the puzzle-piece icon in your browser’s toolbar, so it’s always one click away.</p>
      </>
    ),
  },
  {
    target: '[data-tour="settings"]',
    title: 'Settings',
    body: <p>Turn on Auto-pause and automatic groups, choose what the toolbar icon opens, manage sync and backups, or delete everything. Your data stays yours: there are no servers and no tracking.</p>,
  },
  {
    title: 'You’re all set',
    body: <p>That’s everything. Open the tour again any time with the <strong>?</strong> button at the top of this page.</p>,
  },
];

const GAP = 12;
const MARGIN = 16;
const CARD_W = 360;

/** The element a step points at, if it is in the page and not hidden (e.g. the sidebar on a narrow window). */
function targetOf(step: TourStep): HTMLElement | null {
  if (!step.target) return null;
  const el = document.querySelector<HTMLElement>(step.target);
  if (!el) return null;
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    if (n.hidden || getComputedStyle(n).display === 'none') return null;
  }
  return el;
}

/**
 * A guided tour over the real dashboard: each step highlights the element it explains and puts a card next
 * to it (or in the middle when there's nothing to point at). Keyboard: → / Enter next, ← back, Esc ends;
 * Tab stays inside the card. Focus returns to where it was when the tour ends.
 */
export function Tour({ onClose, steps = TOUR_STEPS }: { onClose: () => void; steps?: TourStep[] }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  const card = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const step = steps[i]!;
  const last = i === steps.length - 1;

  useLayoutEffect(() => {
    const measure = () => {
      setView({ w: window.innerWidth, h: window.innerHeight });
      const el = targetOf(step);
      if (!el) return setRect(null);
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    targetOf(step)?.scrollIntoView?.({ block: 'nearest' });
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step]);
  useEffect(() => {
    card.current?.focus();
  }, [i]);
  useEffect(() => () => {
    if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
  }, []);

  const next = () => (last ? onClose() : setI(i + 1));
  const back = () => setI(Math.max(0, i - 1));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      next();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      back();
    } else if (e.key === 'Tab' && card.current) {
      const f = [...card.current.querySelectorAll<HTMLElement>('button:not([disabled])')];
      if (!f.length) return;
      const first = f[0]!;
      const end = f[f.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === card.current)) {
        e.preventDefault();
        end.focus();
      } else if (!e.shiftKey && document.activeElement === end) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  // Card placement: below the target, else above, else beside it; always inside the window.
  const w = Math.min(CARD_W, view.w - 2 * MARGIN);
  let style: Record<string, string>;
  if (rect) {
    const left = Math.max(MARGIN, Math.min(rect.left, view.w - w - MARGIN));
    const below = rect.top + rect.height + GAP;
    const roomBelow = view.h - below - MARGIN;
    if (roomBelow >= 220) style = { top: `${below}px`, left: `${left}px` };
    else if (rect.top - GAP - MARGIN >= 220) style = { bottom: `${view.h - rect.top + GAP}px`, left: `${left}px` };
    else {
      const side = rect.left + rect.width + GAP;
      style = side + w + MARGIN <= view.w
        ? { top: `${Math.max(MARGIN, Math.min(rect.top, view.h - 320))}px`, left: `${side}px` }
        : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
    }
  } else {
    style = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }
  style.width = `${w}px`;

  const titleId = 'tour-title';
  return (
    <div class="tour" onKeyDown={onKeyDown}>
      {rect ? (
        <div
          class="tour-spot"
          style={{ top: `${rect.top - 4}px`, left: `${rect.left - 4}px`, width: `${rect.width + 8}px`, height: `${rect.height + 8}px` }}
        />
      ) : (
        <div class="tour-dim" />
      )}
      <div ref={card} class="tour-card" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} style={style}>
        <p class="tour-step">{`${i + 1} of ${steps.length}`}</p>
        <h2 class="tour-title" id={titleId}>{step.title}</h2>
        <div class="tour-body">{step.body}</div>
        <div class="tour-actions">
          <button type="button" class="btn btn-ghost btn-sm tour-skip" onClick={onClose}>{last ? 'Close' : 'Skip tour'}</button>
          <span class="tour-nav">
            <button type="button" class="btn btn-sm" disabled={i === 0} onClick={back}>Back</button>
            <button type="button" class="btn btn-sm btn-primary" onClick={next}>{last ? 'Done' : 'Next'}</button>
          </span>
        </div>
      </div>
    </div>
  );
}
