import { useEffect, useState } from 'preact/hooks';
import { LogoMark, PauseIcon } from '../common/icons';
import { InterestsCard, type InterestsCardProps } from './Interests';
/** True once the browser says the toolbar icon is not pinned (unknown where the API is missing: no hint). */
function useUnpinned(): boolean {
  const [unpinned, setUnpinned] = useState(false);
  useEffect(() => {
    const get = typeof chrome.action?.getUserSettings === 'function' ? chrome.action.getUserSettings : undefined;
    get?.().then((s) => setUnpinned(s.isOnToolbar === false), () => undefined);
  }, []);
  return unpinned;
}
/**
 * First run (settings.onboarded false). Its first screen is the interests step, while that is unanswered
 * (`interests` given); then privacy in three lines, and an offer to turn on auto-sleep.
 */
export function Onboarding(props: {
  busy: boolean; onAutoSleep: () => void; onDone: () => void; onTour?: () => void; interests?: InterestsCardProps;
}) {
  return props.interests ? (
    <InterestsCard
      {...props.interests} icon={<LogoMark size={28} />} title="What do you browse most?"
      intro="Pick your topics and Tablight makes a group for each. Skip to start with the usual groups."
    />
  ) : <Welcome {...props} />;
}
function Welcome(props: { busy: boolean; onAutoSleep: () => void; onDone: () => void; onTour?: () => void }) {
  const unpinned = useUnpinned();
  return (
    <section class="card onboarding" aria-labelledby="onboarding-h">
      <LogoMark size={28} />
      <div class="card-text">
        <h2 id="onboarding-h" class="card-title" tabIndex={-1}>Welcome to Tablight</h2>
        <ul class="onboarding-points">
          <li>Tablight sees only each tab’s title and address. It cannot see your passwords, cookies, what you type or what is on a page.</li>
          <li>Grouping runs on your computer. No servers, no analytics. The only network request is the optional Look it up, after you confirm the text.</li>
          <li>Nothing leaves your device except saved tabs and taught examples (synced through your browser account while sync is on) and, only when you click Look it up and confirm, the text you saw.</li>
          {unpinned && (
            <li>
              <strong>Pin Tablight</strong> so it’s one click away: click the puzzle-piece icon in the toolbar, then
              the pin next to Tablight.
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
