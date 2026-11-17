# Suspicious tabs: design

Date: 2026-11-17. Status: draft for approval.

## Why

Ad, scam and malware pages often open tabs behind the user's back: pop-unders, ad-click redirects, "you won" pages. Ad blockers act on page loads, so a tab that is already open stays open, often in another window or far down the tab strip, and nobody notices. (Seen for real in the Edge test: a gambling "deposit bonus" tab sat unnoticed in the background.) Tablight sees every tab in every window, so it can point these out and let the user close them in one go.

Success: a hidden spam tab is noticed within moments and closed with one confirmed click, and a normal user browsing normally never sees a false alarm.

## Goals

- Flag tabs that look like unwanted ad, scam or malware tabs, each with a plain reason.
- Show them in a **Suspicious** view (dashboard sidebar and side panel), only when there is at least one.
- Make them noticeable through the toolbar badge, without notifications.
- Close one, or all, after a confirmation. Let the user keep a tab they trust.

## Non-goals

- Not a security product. No claim of protection, blocking or malware scanning in UI or store text ("looks suspicious", never "malware detected").
- Not a topic group, not guessed by the AI model.
- No bundled list of bad domains in this version (could be added later on top).
- No blocking of pages or pop-ups; only tabs that already exist.

## Anti-goals (would make it a failure even if it works)

- Frightening the user: no system notifications, no red full-screen warnings, no alarming wording. (The user was scared by Edge's sync popup; Tablight must not do the same.)
- Closing anything on its own. Every close is the user's click plus a confirmation.
- Flagging ordinary background tabs (Ctrl/Cmd-click "open for later" is normal and common).
- Any new permission, any network request, any page content access.

## Constraints

- Permissions unchanged: tabs, storage, unlimitedStorage, alarms, offscreen, favicon, sidePanel (+ optional tabGroups). No `notifications`, no `webNavigation`, no host permissions.
- Zero network (CSP `connect-src 'self'`). All rules bundled.
- Only what `chrome.tabs` gives: URL, title, window type, `openerTabId`, active/last-accessed. Redirect chains are not visible; only the address the tab ends on.
- "Never viewed" (`Item.opened === false`) is only known for tabs that appeared during this browser session. Tabs restored at start count as viewed, so a spam tab left from yesterday can still be flagged by address and title clues, but not by the "never viewed" clue.
- New per-tab data (opener, popup window, flag state) is local only: never synced, exported or written to sessions.

## Approaches considered

1. **Combined clues (chosen).** A few transparent rules on behaviour, address and title; flag only when clues combine. Explainable, small, testable, catches the behaviour itself.
2. AI model "spam" category. Rejected: reads only title and address, scam pages copy normal titles, can't explain itself, least accurate.
3. Bundled list of known bad domains. Rejected for now: misses new domains (they change daily), can only refresh with releases, adds megabytes and licence obligations. Can be layered on later.

The user picked 1.

## Detection

### Clues

Behaviour clues (how the tab arrived):
- **B1 Opened by another tab on a different site**: `openerTabId` set when created and the opener's domain differs from the tab's domain.
- **B2 Opened in a pop-up window**: the tab's window has type `popup` (pop-unders).
- **B3 Never viewed**: `opened === false`.

Content clues (what the tab is):
- **C1 Ad-click or tracking address**: ad-network click/redirect shapes (e.g. paths like `/click`, `/redirect`, `/go/` with click-id style query keys such as `key=`, `visitor_id=`, `clickid=`, `zoneid=`, `campaign_id=`), a raw public IP host (loopback, private, link-local, `0.0.0.0/8`, CGNAT/Tailscale `100.64.0.0/10` and IPv4-mapped `::ffff:` hosts do not count), or a punycode (`xn--`) host or a host on a short bundled list of disposable TLD patterns used by spam (e.g. `.space`, `.top`, `.xyz`, `.click`) only when combined with a click-style path or click-id query key. A punycode host on its own is not a clue (see Decision 9).
- **C2 Scam title**: bundled phrase patterns, case-insensitive, whole phrases not single words: prize/winner ("you won", "you have been selected", "claim your prize"), gambling bonus ("deposit bonus", "free spins", "reveal your bonus"), fake alerts ("your pc is infected", "virus detected", "your computer is locked", "call microsoft support"), fake updates ("update your flash player", "your browser is out of date").

### Rule

A tab is suspicious when it has **at least one content clue and at least two clues in total**.

- Ctrl-click background tabs (B1 + B3, no content clue) are never flagged.
- The Edge gambling tab (B3 + C1 + C2) is flagged.
- A known spammy title alone (C2 only) is not flagged; with C1 or any behaviour clue it is.

Only open/sleeping web tabs are checked (`classifiable`, not stashed). Tablight's own pages and browser pages never are.

Clues are recomputed whenever the index updates. Viewing a tab removes B3 but keeps the others, so a viewed scam tab can stay flagged if it still has two clues.

### Kept tabs

"Keep" on a flagged tab stops flagging that tab (by tab id) until it closes or navigates to another site. Not synced; nothing is remembered across browser restarts. (Builder may decide to key it per tab+domain.)

## User interface

### Suspicious view

- A sidebar entry **Suspicious** with a count, shown only when the count is above 0, placed with the special views (after Duplicates). Route `#view=suspicious`.
- Each row: favicon, title, domain, and the reasons in plain words, joined: "Opened by another site · never viewed · ad-click address". Actions: **Go to tab**, **Keep**, **Close**.
- Header button **Close all (N)** → confirmation modal listing the tabs ("Close 3 suspicious tabs?" with titles), buttons "Close tabs" / "Cancel". After closing, the existing undo toast if the close path supports reopening; otherwise the confirmation is the safeguard.
- Short neutral explanation line at the top: "These tabs opened in the background and look like ads or scams. Tablight never closes tabs on its own."
- Empty state not needed (entry hides at 0); if routed there with 0, show "No suspicious tabs."

### Side panel

A compact "Suspicious (N)" section at the top of the side panel when N > 0, same rows and Close all.

### Toolbar badge

The badge today shows a per-tab duplicate count ("2×", grey). While at least one suspicious tab exists, every tab's badge shows **!** on an amber/red background instead; when none remain, duplicate counts return. Tooltip (action title) reads "Tablight: 2 suspicious tabs". Clicking the icon behaves as today; the popup shows a one-line link "2 suspicious tabs → Review" when N > 0.

### Copy rules

Plain, calm, never "malware", "virus" or "danger" in Tablight's own words. "Looks like an ad or scam" at most.

## Settings

One toggle in Settings: "Point out suspicious tabs" (default on). Off hides the view, the badge state and stops checking.

## Testing and accuracy

- Unit tests for each clue and for the rule, including: Ctrl-click background tab (not flagged), pop-up OAuth sign-in window that was viewed (not flagged), Edge gambling tab (flagged), scam title alone (not flagged).
- **False-alarm test:** run the content clues over every tab in the existing training and holdout sets (normal browsing, ~2,500 tabs). Content clues may fire on a handful; with any one behaviour clue added, the rule must flag 0 of them, i.e. no title+address pair in the normal corpus has both C1 and C2. Report how many fire C1 or C2 alone.
- **Catch test:** a hand-made fixture of ~40 real-shaped spam tabs (ad-click URLs, scam titles, pop-under setups) with an expected catch rate reported, not asserted at 100%.
- The badge, view and close flow checked in the real extension (Chrome for Testing).

## Docs to update

Privacy policy (what is stored locally: opener site and pop-up flag, never sent anywhere), store listing feature line, design spec §12 cross-reference, onboarding not changed.

## Decisions settled after review (author's calls)

1. **Opener domain is captured at creation.** In `tabs.onCreated`, if `openerTabId` is set, look up the opener's current URL at that moment and record `{ openerDomain }` for the new tab in `chrome.storage.session` (survives worker restarts, cleared on browser restart). B1 compares against that recorded domain, never the opener's later state. No record (opener unknown, already gone, restored tab) means B1 is false.
2. **Pop-up window type is cached per window id** (`chrome.windows.get` once per new window id, also in session storage). B2 is evaluated continuously from the tab's current window, so a tab dragged out of a pop-up loses B2.
3. **C1 and C2 count as two separate clues.** A restored tab (no behaviour clues known) is flagged only when both its address and title match. This is accepted.
4. **Kept tabs go in `chrome.storage.session`** as `tabId → domain`. A kept tab is unflagged until it closes or its domain changes. It survives worker restarts but not browser restarts.
5. **Badge:** while N > 0, every indexed tab's badge text is "!" (the per-tab cache is reused, so only changed tabs are touched), and the action title is set globally. The count reaches the dashboard, side panel and popup through the existing state RPC.
6. **Closing uses the existing close path**, which already issues an undo token for the undo toast. Confirmation and undo both apply.
7. **Setting:** `suspiciousTabs: boolean` (default true) is added to `Settings` with a default for older data. It follows the same sync behaviour as other settings. Turning it off stops checking and clears the "!" badge state, while opener and kept records stay until the browser restarts (they are harmless and local).
8. **False-alarm test covers content clues only**, run over `tests/quality/fixture.json`, `holdout.json`, `holdout2.json` and `training/*.json`. It asserts that no normal tab has both C1 and C2, and reports how many fire either one. Behaviour clues are covered by unit tests.
9. **A punycode (`xn--`) host is a clue only with a click shape.** Every internationalised domain (münchen.de, `.рф`, `.中国`) is `xn--` in the URL, so a Ctrl-clicked IDN site would otherwise get B1 + B3 + C1 and be flagged, against the success criterion that normal browsing never raises a false alarm. Punycode therefore counts only together with a click-style path or a click-id query key, like the spam TLDs. Accepted cost: a look-alike (homograph) host with a clean path and no scam title is not flagged.

## Left to the builder

Exact regexes and phrase list, where the clue code lives (a new `src/background/suspicious.ts` alongside `duplicates.ts` is the natural place), how opener domains survive a service-worker restart (e.g. `chrome.storage.session`), the exact badge colour within the existing palette, and row layout reusing ItemGrid styles.
