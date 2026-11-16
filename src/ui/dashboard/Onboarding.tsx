import { useEffect, useState } from 'preact/hooks';
import { LogoMark, PauseIcon } from '../common/icons';
/** True once the browser says the toolbar icon is not pinned (unknown where the API is missing: no hint). */
function useUnpinned(): boolean {
  const [unpinned, setUnpinned] = useState(false);
  useEffect(() => {
    const get = typeof chrome.action?.getUserSettings === 'function' ? chrome.action.getUserSettings : undefined;
    get?.().then((s) => setUnpinned(s.isOnToolbar === false), () => undefined);
  }, []);
  return unpinned;
}
/** First run (settings.onboarded false): privacy in three lines, and an offer to turn on auto-sleep. */
export function Onboarding(props: { busy: boolean; onAutoSleep: () => void; onDone: () => void; onTour?: () => void }) {
  const unpinned = useUnpinned();
  return (
    <section class="card onboarding" aria-labelledby="onboarding-h">
      <LogoMark size={28} />
      <div class="card-text">
        <h2 id="onboarding-h" class="card-title">Welcome to Tab Organizer</h2>
        <ul class="onboarding-points">
          <li>Nothing leaves your device except tabs you save for later and the examples you teach your groups, which sync through your browser account: no servers, no analytics.</li>
          <li>Grouping runs on your computer, using only each tab’s title and address.</li>
          <li>Saved tabs sync only through your browser account, and you can turn that off in Settings.</li>
          {unpinned && (
            <li>
              <strong>Pin Tab Organizer</strong> so it’s one click away: click the puzzle-piece icon in the toolbar, then
              the pin next to Tab Organizer.
            </li>
          )}
        </ul>
        <div class="card-actions">
          {props.onTour && (
            <button type="button" class="btn btn-sm btn-primary" disabled={props.busy} onClick={props.onTour}>Take the tour</button>
          )}
          <button type="button" class="btn btn-sm" disabled={props.busy} onClick={props.onAutoSleep}>
            <PauseIcon />Auto-pause tabs unused for 1 hour
          </button>
          <button type="button" class="btn btn-sm" disabled={props.busy} onClick={props.onDone}>Got it</button>
        </div>
      </div>
    </section>
  );
}
