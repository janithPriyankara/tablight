import { LogoMark, MoonIcon } from '../common/icons';
/** First run (settings.onboarded false): privacy in three lines, and an offer to turn on auto-sleep. */
export function Onboarding(props: { busy: boolean; onAutoSleep: () => void; onDone: () => void }) {
  return (
    <section class="card onboarding" aria-labelledby="onboarding-h">
      <LogoMark size={28} />
      <div class="card-text">
        <h2 id="onboarding-h" class="card-title">Welcome to Tab Organizer</h2>
        <ul class="onboarding-points">
          <li>Nothing leaves your device except stashed tabs: no servers, no analytics.</li>
          <li>Grouping runs on your computer, using only each tab’s title and address.</li>
          <li>Stashed tabs sync only through your browser account, and you can turn that off in Settings.</li>
        </ul>
        <div class="card-actions">
          <button type="button" class="btn btn-sm btn-primary" disabled={props.busy} onClick={props.onAutoSleep}>
            <MoonIcon />Turn on auto-sleep after 60 min
          </button>
          <button type="button" class="btn btn-sm" disabled={props.busy} onClick={props.onDone}>Got it</button>
        </div>
      </div>
    </section>
  );
}
