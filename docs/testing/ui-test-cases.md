# Tablight UI test cases

A checklist of everything you can see and click in Tablight, written so anyone can follow it by hand. Each row
says what to do, what you should see, and which automated test already does the same thing in a real browser.

## Before you start

- Install Tablight (the store version, or `npm run build` and load the `dist` folder as an unpacked extension).
- Open a handful of ordinary web pages in two windows: a few about one topic (for example three travel pages), a
  few about another, and the same page twice (a duplicate).
- "The dashboard" is the full Tablight page: click the Tablight icon, then **Open dashboard** (or press
  Alt+Shift+T). Its left column is the **sidebar**.
- After a close, a save or a removal, a message appears at the bottom with **Undo**. It disappears after 10
  seconds.

Tablight points out a tab when it has an ad-click address or a scam-style title, plus at least one more clue.
This recipe gives a test tab all four the rows below rely on: opened by another site, never viewed, an
ad-click address and a scam-style title. It needs Python 3 and nothing on the internet. A page opened
straight from a file does not work: only http(s) pages are checked.
1. Make an empty folder with two files:
   - `opener.html`:
     `<a href="http://127.0.0.1:8000/click/?key=1&visitor_id=2">Open the test page</a>`
   - `click/index.html` (in a sub-folder named `click`):
     `<title>Congratulations! You won a prize</title><p>A test page for Tablight.</p>`
2. In a terminal in that folder run `python3 -m http.server 8000 --bind 127.0.0.1`. It serves the folder to
   your own computer only. Stop it with Ctrl+C when you are done.
3. In the browser go to `http://localhost:8000/opener.html` and **Ctrl-click** (Cmd-click on a Mac) the link,
   so it opens in a background tab. Do not switch to it.
4. Within a few seconds every tab's Tablight icon shows "!" and the dashboard lists **Suspicious 1**, with the
   reasons "Opened by another site · Never viewed · Ad-click address · Scam-style title".
Why it works: `localhost` and `127.0.0.1` count as two different sites, `/click/` with `key=` and `visitor_id=`
is an ad-click address (even on your own computer), and "You won" is a scam-style title. Ctrl-click the link
again for a second suspicious tab (Close all needs two). A plain local address such as
`http://127.0.0.1:8000/` is never an ad-click address by itself.

## How to read the "Automated by" column

- `ui-dashboard.spec.ts › D-13` means the test whose name starts with `D-13` in `tests/e2e/ui-dashboard.spec.ts`
  does exactly these steps in a real Chromium with the built extension. Several rows can share one test.
- `extension.spec.ts › flows` and the `suspicious.spec.ts` names refer to the older end-to-end tests.
- "manual — reason" means a person has to check it, and why a test cannot.
- Run them all with `npm run build && npm run test:e2e`.

---

## 1. Dashboard: sidebar and All tabs

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| D-01 | Open the dashboard. Look at the sidebar. | All tabs, Unsorted, Duplicates, Saved for later, Sessions, Settings are listed, then your groups with how many tabs each holds. **Suspicious** is not listed while no tab is suspicious. Counts show only when above zero. | ui-dashboard.spec.ts › D-01..D-04 |
| D-02 | Click each entry of the sidebar in turn. | The big heading changes to that name, the entry is highlighted, and the address bar ends in `#view=…` (or `#group=…`). | ui-dashboard.spec.ts › D-01..D-04 |
| D-03 | Open Saved for later, then reload the page. | You stay on Saved for later. | ui-dashboard.spec.ts › D-01..D-04 |
| D-04 | Change the address to end in `#group=no-such-group`. | Heading "Group not found", the text "This group no longer exists." and a **Show all tabs** button that goes back to All tabs. | ui-dashboard.spec.ts › D-01..D-04 |
| D-05 | Open All tabs. Read the line under the heading. | "N tabs · N windows · N paused · N saved · N new", matching your browser. | ui-dashboard.spec.ts › D-01..D-04 |
| D-06 | Open three pages in the background (Ctrl/Cmd-click links). In All tabs click **Show new only**, then switch to one of them and come back. | Only never-viewed tabs are listed, each marked "New". After you viewed one it is no longer new; **Show all** lists everything again. | ui-dashboard.spec.ts › D-05 |
| D-07 | Click a tab's title in any list. | The browser switches to that tab, even in another window. | extension.spec.ts › clicking an entry… |
| D-08 | Click a paused tab's title. | It switches to the tab and the page loads again. | extension.spec.ts › clicking an entry… |
| D-09 | Close a tab in the browser and, before the list updates, click it in the dashboard. | "That tab was already closed"; the row disappears. | extension.spec.ts › clicking an entry… |

## 2. Dashboard: actions on a tab, selection, moving

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| D-10 | Hover a tab, click **Pause** (pause icon). | "Paused 1 tab" with a one-time explanation underneath; the row is marked "Paused"; the tab stays in the tab strip but unloads. A paused tab has no Pause button. | ui-dashboard.spec.ts › D-10..D-12 |
| D-11 | Pause a second tab. | "Paused 1 tab" without the explanation (it shows only the first time). | ui-dashboard.spec.ts › D-10..D-12 |
| D-12 | Combination: on a **paused** tab click **Close**, then **Undo**. | The tab closes ("Closed 1 tab"); Undo reopens it ("Undone") and it is listed again. | ui-dashboard.spec.ts › D-10..D-12 |
| D-13 | Combination: open a group, click **Save for later** on one of its tabs, then **Undo**. | The tab closes and stays listed in the group, marked "Saved", with a one-time explanation. Undo reopens it, in the same group, and nothing stays saved. | ui-dashboard.spec.ts › D-13..D-15 |
| D-14 | Save it again. Open **Saved for later** and click **Open** (arrow icon) on it. | Sidebar shows "Saved for later 1". Open brings the tab back and it leaves Saved for later. | ui-dashboard.spec.ts › D-13..D-15 |
| D-15 | Look at that reopened tab. | It is back in the group it was saved from. | ui-dashboard.spec.ts › D-13..D-15 |
| D-16 | Click **Move to group** on a tab. Pick a group in the "Move to…" menu that appears. | The tab is selected, the menu gets the focus; "Moved 1 tab to <group>"; the tab is in that group from now on. | ui-dashboard.spec.ts › D-16..D-18 |
| D-17 | Drag a tab onto a group in the sidebar. | The group lights up while you hover; "Moved 1 tab to <group>". | ui-dashboard.spec.ts › D-16..D-18 |
| D-18 | Tick two tabs, click **New group**. Try an empty name, then type "Reading pile" and **Create group**. | Create is greyed out while the name is empty; then "Created Reading pile with 2 tabs" and "Reading pile 2" in the sidebar. | ui-dashboard.spec.ts › D-16..D-18 |
| D-19 | Tick a tab, Shift-click the tick box two rows down, Ctrl/Cmd-click another row, Ctrl/Cmd-click it again, then **Clear**. | 3 selected, then 4, then 3; Clear removes the selection bar. | ui-dashboard.spec.ts › D-19..D-21 |
| D-20 | Select two tabs and use the bar's **Pause**, then **Save for later**. | "Paused 2 tabs", then "Saved 2 tabs for later" (paused tabs can be saved). | ui-dashboard.spec.ts › D-19..D-21 |
| D-21 | Select two tabs, **Close**, then **Undo**. | "Closed 2 tabs"; Undo brings both back. | ui-dashboard.spec.ts › D-19..D-21 |
| D-22 | In Saved for later select 21 saved tabs and click **Open**. Cancel, then try with 19. | With more than 20, "Open 21 tabs?" asks first and Cancel opens nothing. 19 open straight away. | ui-dashboard.spec.ts › D-22..D-23 |
| D-23 | Select saved tabs and click the bar's **Remove from Saved for later**. | "Removed 2 saved tabs"; they leave the list. | ui-dashboard.spec.ts › D-22..D-23 |

## 3. Dashboard: Saved for later

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| D-30 | Open Saved for later with nothing saved. | "Nothing saved yet. …" and no Remove all button. | ui-dashboard.spec.ts › D-30..D-32 |
| D-31 | Click the bin on one saved tab, then **Undo**. | "Removed 1 saved tab"; Undo puts it back. | ui-dashboard.spec.ts › D-30..D-32 |
| D-32 | Click **Remove all**, **Cancel**; then Remove all and confirm; then **Undo**. | The question "Remove 3 saved tabs?" has the focus on Cancel; Cancel keeps all; confirming empties the list; Undo restores all 3. | ui-dashboard.spec.ts › D-30..D-32 |
| D-33 | Settings → "Remove a saved tab… when I open it" on and off, then open a saved tab. | See S-01. | ui-settings.spec.ts › S-01 (on / off) |

## 4. Dashboard: search

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| D-40 | Type a word from a tab's title in the search box. | Heading "Results for “word”", the matching tabs, and "N matches". | ui-dashboard.spec.ts › D-40..D-43 |
| D-41 | Type it with a typo ("kyotto"). | Still found. | ui-dashboard.spec.ts › D-40..D-43 |
| D-42 | Combination: search for a **saved** tab and click it. | It is listed, marked "Saved"; clicking opens it as a tab. | ui-dashboard.spec.ts › D-40..D-43 |
| D-43 | Search for nonsense, then press Esc. | "No matches" / "0 matches"; Esc empties the box and shows the view again. | ui-dashboard.spec.ts › D-40..D-43 |
| D-44 | Open pages about investing for retirement (index funds, a Roth IRA) and some others. Search for a word that is in no title, e.g. "pension". | Related tabs (the retirement pages first) are listed, marked "Similar by meaning". | ui-dashboard.spec.ts › D-44 |

## 5. Dashboard: groups and Unsorted

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| D-50 | Open a group with three tabs. | Heading with the group's colour dot, "3 items · 3 new". | ui-dashboard.spec.ts › D-50..D-55 |
| D-51 | Click **Pause group**. | "Paused 3 tabs". | ui-dashboard.spec.ts › D-50..D-55 |
| D-52 | Click the pencil (**Rename group**). Empty the name, then type "Trips" and press Enter. | The name is filled in; Rename is greyed out while empty; heading and sidebar now say "Trips". | ui-dashboard.spec.ts › D-50..D-55 |
| D-53 | Click **Merge group**, pick "Finance", **Merge**. | You land on Finance, which now holds the tabs; Trips is gone. | ui-dashboard.spec.ts › D-50..D-55 |
| D-54 | Click the bin (**Delete group**): Cancel, then confirm. | "Delete Finance?" explains the tabs go back to Unsorted. Cancel keeps it. Confirming removes the group, shows All tabs, and **closes no tab**. | ui-dashboard.spec.ts › D-50..D-55 |
| D-55 | Open the group **Other**. | Rename and Merge are there, Delete is not. Empty: "No tabs in this group yet. Drag tabs here to teach it." | ui-dashboard.spec.ts › D-50..D-55 |
| D-56 | In a group click **Save group for later**. | All its open tabs close into Saved for later ("Saved N tabs for later"); other tabs stay; the button greys out. | ui-dashboard.spec.ts › D-56 |
| D-57 | Save two YouTube videos (one with `&t=754`) and an article into one group. | Sidebar shows "▶ 2" next to the group, the group says "3 items · 2 to watch", the first video says "from 12:34", the popup's group tile says "2 to watch". | ui-dashboard.spec.ts › D-57 |
| D-58 | Open **Unsorted**. | Tabs without a group; **Save group for later** and **Pause group** work here too. | ui-dashboard.spec.ts › D-60..D-62 |
| PR-01 | On a web page press **Alt+P**; open the dashboard; press **Alt+Shift+P** on the same page. | The badge shows ★ for about 2 s, then what it showed before. **Priority** is listed first in Groups with a star, holding the tab; it has no Rename, Merge or Delete. Alt+Shift+P puts the tab back in the group it was in (badge –); the empty Priority entry leaves the sidebar. Both keys do nothing on browser pages, Tablight's pages and in private windows. | priority.spec.ts › PR-01 (through the shortcut's message; the real key press is manual) |
| PR-02 | Hover a row and click the star; click it again. | "Added 1 tab to Priority"; the tab is in Priority; the second click puts it back. The selection bar has **Prioritize** (or **Remove from Priority** when every selected tab is there). | priority.spec.ts › PR-02 |

## 6. Dashboard: suggested groups

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| D-60 | Open 4–5 pages on a topic Tablight has no group for (e.g. beekeeping). | A **Suggested groups** section appears in the sidebar with a named group. | ui-dashboard.spec.ts › D-60..D-62 |
| D-61 | Click the suggestion. | Heading with a "Suggested" label, and **Accept group** / **Dismiss** buttons. | ui-dashboard.spec.ts › D-60..D-62 |
| D-62 | Click **Dismiss**, then open another tab. | The suggestion disappears, its tabs go to Unsorted, and the same suggestion does not come back. | ui-dashboard.spec.ts › D-60..D-62 |
| D-63 | Click the tick (**Accept …**) next to a suggestion in the sidebar. | It becomes a normal group (rename, merge, delete available). | ui-dashboard.spec.ts › D-63 |
| D-64 | Combination: auto-create groups **on** / **off** (Settings), then open a new topic. | See S-03. | ui-settings.spec.ts › S-03 (on / off) |

## 7. Dashboard: Duplicates and Re-group

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| D-70 | Combination: open the same page twice; it belongs to a group. | Sidebar: "Duplicates 1"; the group counts both copies. Duplicates lists both copies, each with its group, "1 extra copy". | ui-dashboard.spec.ts › D-70..D-73 |
| D-71 | Click **Close duplicates**, then **Cancel**. | "Close 1 duplicate tab?"; Cancel keeps both. | ui-dashboard.spec.ts › D-70..D-73 |
| D-72 | Close duplicates and confirm. | One copy stays; "No page is open more than once."; the button greys out; the group count drops by one. | ui-dashboard.spec.ts › D-70..D-73 |
| D-73 | Click **Undo**. | The copy is back. | ui-dashboard.spec.ts › D-70..D-73 |
| D-74 | Click **Re-group everything**. Cancel, then do it again and Apply. | A table of groups "Now / After / Change", or "Nothing to change"; Cancel changes nothing; Apply says "Re-grouped N tabs" or "Nothing needed to move". | ui-dashboard.spec.ts › D-74 |

## 8. Dashboard: Suspicious

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| D-75 | A normal page opened in the background by another site; a "You won't believe…" page. | Not flagged; no Suspicious entry, no "!" badge. | suspicious.spec.ts › a normal background tab… / a “You won’t believe…”… |
| D-76 | A spam page (ad-click address, prize title) opens in the background from another site (see "How to make a suspicious tab by hand"). | Sidebar "Suspicious 1", the "!" badge, the explanation, the reasons line. | suspicious.spec.ts › a spam tab opened by another site… |
| D-77 | Same in a pop-up window. | Reasons include "Opened in a pop-up window". | suspicious.spec.ts › a spam page in a pop-up window… |
| D-78a | Make a suspicious tab (see "How to make a suspicious tab by hand"). In the Suspicious view click **Go to tab** on its row, then come back to the dashboard. | The browser switches to that tab. The row is still listed (its other clues remain), but "Never viewed" is gone from its reasons. | suspicious.spec.ts › Go to tab switches to it… |
| D-78b | On a suspicious row click **Keep** (a text button with a tick on the dashboard; narrow the window below about 700 px and only the tick shows). Reload the dashboard. | The row goes and the tab stays open. If it was the only one, the "!" badge goes back to normal (a copy count or nothing). After the reload it is still not listed and the view says "No suspicious tabs.". | suspicious.spec.ts › Keep hides the row… (Keep as a visible word included); the icon-only narrow layout is manual |
| D-78c | On a suspicious row click **Close**, then **Undo** in the message at the bottom. | The tab closes at once (no question) with "Closed 1 tab" and Undo; Undo reopens it. | suspicious.spec.ts › Close closes the tab… |
| D-78d | Make two suspicious tabs. Click **Close all (2)** in the top bar: first **Cancel**, then again and **Close tabs**, then **Undo**. | A window "Close 2 suspicious tabs?" lists both titles. Cancel closes nothing. Close tabs closes both; Undo reopens both. | suspicious.spec.ts › Close all with two spam tabs… |
| D-78e | Keep a suspicious tab (D-78b). In that tab go to a page on another site, then back to the suspicious address. | Once it left the site the keep ends: back on the suspicious address it is listed again and the "!" badge returns. | suspicious.spec.ts › Keep hides the row… |
| D-78f | In a suspicious tab, go to a normal page on the same site (for example `http://127.0.0.1:8000/`). | It is no longer listed; the "!" badge and the sidebar entry go away. | suspicious.spec.ts › a spam tab that navigates to a normal page… |
| D-78g | With no suspicious tab, change the dashboard's address to end in `#view=suspicious`. | Heading "Suspicious" and the text "No suspicious tabs.". | suspicious.spec.ts › #view=suspicious with nothing flagged… |
| D-79 | Combination: a suspicious tab plus a duplicate pair; close the suspicious one. | "!" wins while it is open; afterwards the copies show "2×" again. | suspicious.spec.ts › a duplicate pair plus a spam tab… |

## 9. Dashboard: Sessions

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| D-80 | Open Sessions with none saved, click **Save session now** with no web tab open. | "No sessions saved yet."; "No web tabs to save". | ui-dashboard.spec.ts › D-80..D-84 |
| D-81 | Open two pages, **Save session now**. | "Session saved"; a row "just now · 1 window · 2 tabs". | ui-dashboard.spec.ts › D-80..D-84 |
| D-82 | Close those tabs, click **Open all**. | They open in a new window. | ui-dashboard.spec.ts › D-80..D-84 |
| D-83 | **Save all for later**. | "Saved the session’s 2 tabs for later"; Saved for later shows 2. | ui-dashboard.spec.ts › D-80..D-84 |
| D-84 | Click the bin (**Delete session**): Cancel, then confirm. | "Delete this session?"; Cancel keeps it; confirming empties the list. | ui-dashboard.spec.ts › D-80..D-84 |
| D-86 | **Open all** on a session of more than 20 tabs; Cancel; then confirm. | "Open 21 tabs?" asks first; Cancel opens nothing; confirming opens all 21. | ui-dashboard.spec.ts › D-86 |
| D-87 | After a browser restart that did not bring your tabs back, open the dashboard. | A card "Your last session (N tabs) wasn’t restored" with **Open all**, **Save all for later**, and a close button. **Dismiss** hides it, also after a reload. | ui-dashboard.spec.ts › D-87..D-88 (the startup check's record is written by the test) |
| D-88 | On that card click **Save all for later**. | The session's tabs are in Saved for later. | ui-dashboard.spec.ts › D-87..D-88 |
| D-89 | Quit the browser with tabs open, start it without "Continue where you left off". | The card of D-87 appears by itself. | manual — needs a real browser restart; the card itself is tested in D-87 |

## 10. Dashboard: loading and errors

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| D-90 | The background does not answer (e.g. right after an update). | "Couldn’t load your tabs: …" with **Retry**; Retry loads the list. If a later refresh fails, the last list stays with "Couldn’t refresh (…). Showing the last known tabs." | ui-dashboard.spec.ts › D-90..D-91 (the failure is simulated in the page) |
| D-91 | Just after install, or with many new tabs. | A banner "Grouping your tabs… The on-device model is sorting them." | ui-dashboard.spec.ts › D-90..D-91 (the "still working" state is simulated) |

## 11. Settings

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| S-01 | Combination: "Remove a saved tab from Saved for later when I open it" **on** (default), open a saved tab. Repeat with it **off**. | On: the tab opens and leaves Saved for later. Off: the tab opens and also stays saved (reading-list mode). The switch keeps its value after a reload. | ui-settings.spec.ts › S-01 (on / off) |
| S-02 | "Auto-pause tabs I haven’t used for": pick 15 minutes, 1 hour, 1 day, Off, reloading each time. | The choice is kept. | ui-settings.spec.ts › S-02 |
| S-02b | Set auto-pause to 15 minutes and leave tabs untouched for 20 minutes. | They show "Paused"; the tab you are on, pinned tabs and tabs playing sound are not paused. | manual — needs 15+ minutes of real idle time (the browser's alarm runs every 5 minutes); the rule is unit-tested (tests/unit/memory.test.ts) |
| S-03 | Combination: "Create new groups automatically" **off**, open a new topic; then turn it **on**. Repeat starting with it **on**. | Off: the topic is suggested; turning the switch on accepts the waiting suggestion. On: the topic becomes a normal group straight away, never a suggestion. | ui-settings.spec.ts › S-03 (on / off) |
| S-10 | Combination: sync **off**, save a tab for later. Then with sync **on**. | Off: "Sync is turned off" (shown as an error), popup "Sync is off", nothing is written to the browser account. On: within a few seconds "Synced 1 · last synced just now", popup "Saved tabs synced just now". | ui-settings.spec.ts › S-10 (on / off) |
| S-11 | The sync line in its other states: never synced, some tabs only on this device, storage full, too many changes, failed. | Settings and popup word each state ("Not synced yet", "Synced 412 · 37 only on this device", "Sync full · saved tabs kept on this device", "Sync paused for a moment", "Sync failed · will retry"). | ui-settings.spec.ts › S-11 (five states; the states are written by the test, the browser's quota cannot be filled on demand) |
| S-12 | Turn sync on with the same browser account signed in on two computers; save a tab on one. | It appears in Saved for later on the other; removing it on one removes it on the other. | manual — needs two real devices signed in to one browser account |
| S-20 | **Export backup**. | A file `tablight-YYYY-MM-DD.json` downloads; "Backup ready"; it contains your saved tabs, groups and sessions. | ui-settings.spec.ts › S-20; extension.spec.ts › flows |
| S-21 | **Import backup…** with a broken file: empty, plain text, cut-off JSON, another app's JSON, a newer version, wrong structure, deeply nested, over 20 MB. | A message says what is wrong ("not valid JSON", "not a Tablight backup", "malformed backup", "file is nested too deeply", "That file is larger than 20 MB…"); nothing is imported; a good file imported next still works. | ui-settings.spec.ts › S-21 (8 files) |
| S-22 | Import a backup with some bad entries, then import it again. | The good tabs are imported ("Imported 1 tab"); the second time nothing new is added. | ui-settings.spec.ts › S-22 |
| S-23 | Import a good backup into a fresh install. | "Imported N tabs"; they appear in Saved for later. | extension.spec.ts › flows |
| S-30 | Combination: "Toolbar icon opens" **Side panel** / **Popup**. | The toolbar icon opens the chosen one; the choice is kept after a reload. | ui-settings.spec.ts › S-30 (both) — checks what the browser's toolbar button is set to; clicking the real icon is manual (B-03) |
| S-31 | Combination: "Mirror groups as browser tab groups" **on**: accept the browser's permission question. | Your groups appear as coloured tab groups in the tab strip; turning it off leaves your tabs alone. | manual — the browser's own permission prompt cannot be answered by the test browser (the request stays pending); mirroring logic is unit-tested (tests/unit/groups.test.ts) |
| S-32 | Mirror **on**, but **deny** the permission question. | "Permission not granted, so tab groups are not mirrored." and the switch stays off. | manual — same prompt |
| S-33 | "Point out suspicious tabs" off, then on. | Off hides the Suspicious entry and the "!" badge; on brings both back. | suspicious.spec.ts › the “Point out suspicious tabs” switch… |
| S-40 | Combination: with saved tabs, a user group, a session and sync on, click **Delete all data**: Cancel, then confirm. | Focus is on Cancel; Cancel keeps everything. Confirming: "All data deleted", the interests step (then the welcome card) is back, Saved for later and Sessions are empty, your group is gone, sync is off, open tabs stay open and listed, one-time tips show again. | ui-settings.spec.ts › S-40 |
| S-41 | After S-40, **Skip** the interests step, then click **Got it** on the welcome card. | The card goes away. | ui-settings.spec.ts › S-40 |
| S-50 | Look at About; click each link (and "Read the privacy policy"). | "Tablight <version>"; each link opens its page in a new tab. | ui-settings.spec.ts › S-50 |
| S-51 | Click **Start the tour**. | See T-03. | ui-onboarding-keyboard.spec.ts › T-03 |

## 12. Popup (click the Tablight icon)

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| P-01 | Open the popup with some tabs, one paused, one duplicate. | "4 tabs · 1 window · 1 paused · 1 duplicate"; **Top groups** tiles with counts. | ui-popup-sidepanel.spec.ts › P-01..P-02 |
| P-02 | Click a group tile. | The popup closes; the dashboard (the one already open, not a second one) shows that group. | ui-popup-sidepanel.spec.ts › P-01..P-02 |
| P-03 | Popup with no tabs grouped. | "Your groups appear here once tabs are sorted." | ui-popup-sidepanel.spec.ts › P-03 |
| P-04 | Type in the search box right away. | The box has the focus; matches are listed. Esc clears it; nonsense says "No matches". | ui-popup-sidepanel.spec.ts › P-04..P-06 |
| P-05 | Search and press Enter. | Switches to the first match; the popup closes. | ui-popup-sidepanel.spec.ts › P-04..P-06 |
| P-06 | Combination: search for a saved tab and click it. | Marked "Saved"; it opens. | ui-popup-sidepanel.spec.ts › P-04..P-06 |
| P-07 | On a page that is open twice, open the popup. | "This tab is open 2 times"; **Switch** goes to the other copy. | ui-popup-sidepanel.spec.ts › P-07..P-08 |
| P-08 | Same, **Close this one**. | This copy closes. | ui-popup-sidepanel.spec.ts › P-07..P-08 |
| P-09 | **Open dashboard**, with and without a dashboard already open. | Goes to the open one (never a second), or opens one. | ui-popup-sidepanel.spec.ts › P-09 |
| P-10 | **Side panel**. | The side panel opens and the popup closes. | ui-popup-sidepanel.spec.ts › P-10 |
| P-11 | **Save window for later** in a window with two pages. | The pages close into Saved for later; the window stays open on the dashboard's Saved for later with "Saved 2 tabs for later" and Undo; Undo brings them back. | ui-popup-sidepanel.spec.ts › P-11..P-12 |
| P-12 | **Save window for later** in a window with no web page. | "No web tabs to save in this window". | ui-popup-sidepanel.spec.ts › P-11..P-12 |
| P-13 | **Pause other tabs**, twice. | "Paused 3 tabs" and "3 paused" in the totals; then "Nothing to pause right now". | ui-popup-sidepanel.spec.ts › P-13 |
| P-14 | The background does not answer / the model is working. | "Couldn’t load your tabs." with Retry; an "Organizing" label while grouping. | ui-popup-sidepanel.spec.ts › P-14 popup.html |
| P-15 | A suspicious tab is open. | "1 suspicious tab" and **Review**, which opens the dashboard's Suspicious view. | suspicious.spec.ts › popup: “1 suspicious tab”… |
| P-16 | Sync line at the bottom, in each sync state. | See S-10 and S-11. | ui-settings.spec.ts › S-10, S-11 |

## 13. Side panel (Alt+Shift+S, or the popup's Side panel button)

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| SP-01 | Open the side panel in a window. | "This window" is open and lists only this window's tabs; groups are folded with their counts. | ui-popup-sidepanel.spec.ts › SP-01..SP-03; extension.spec.ts › side panel… |
| SP-02 | Unfold a group, fold "This window", close and reopen the panel. | Folded/unfolded sections are remembered. | ui-popup-sidepanel.spec.ts › SP-01..SP-03 |
| SP-03 | Click a tab in the panel. | The browser switches to it; the panel stays open. | extension.spec.ts › side panel… |
| SP-04 | Look at the row of the tab you are on. | It is highlighted and has no Pause button. | ui-popup-sidepanel.spec.ts › SP-04..SP-07 |
| SP-05 | **Pause** another tab. | "Paused 1 tab"; the row says "Paused". | ui-popup-sidepanel.spec.ts › SP-04..SP-07 |
| SP-06 | **Save for later** on a tab, then **Undo**. | It closes; Undo reopens it ("Undone"). | ui-popup-sidepanel.spec.ts › SP-04..SP-07 |
| SP-07 | **Close** a tab, then **Undo**. | It closes; Undo reopens it. | ui-popup-sidepanel.spec.ts › SP-04..SP-07 |
| SP-08 | Search and press Enter; then Esc. | Switches to the match, the panel stays; Esc clears. | ui-popup-sidepanel.spec.ts › SP-08..SP-10 |
| SP-09 | **Pause other tabs**. | Every web tab except the one you are on pauses. | ui-popup-sidepanel.spec.ts › SP-08..SP-10 |
| SP-10 | **Dashboard**. | The dashboard comes to the front. Tabs without a group are under "Unsorted". | ui-popup-sidepanel.spec.ts › SP-08..SP-10 |
| SP-11 | A group with more than 300 tabs. | 300 are listed and "Show all 301 in the dashboard" opens the dashboard. | ui-popup-sidepanel.spec.ts › SP-11 |
| SP-12 | Four suspicious tabs. | "Suspicious (4)" shows 3 rows and "Show all (4)" / "Show fewer"; the heading folds it. | ui-popup-sidepanel.spec.ts › SP-12 |
| SP-13 | Suspicious: Close all in the panel. | Asks inside the panel, lists the tabs, closes both. | suspicious.spec.ts › side panel: “Suspicious (N)”… |
| SP-16 | Two suspicious tabs: in the panel's Suspicious section click **Keep** (the tick icon; the panel has icon buttons, each named "Keep" plus the title for screen readers) on one. | That row goes from the panel ("Suspicious (1)") and from the dashboard's Suspicious view; the tab stays open, and "!" stays while the other is flagged. | suspicious.spec.ts › side panel: Keep is an icon button… |
| SP-14 | Errors and "Organizing", as P-14. | Same as the popup. | ui-popup-sidepanel.spec.ts › P-14 sidepanel.html |
| SP-15 | Open an empty new tab while the panel is open. | The panel hides on the empty tab and comes back on a normal page. | ui-popup-sidepanel.spec.ts › SP-15 & S-30 default (the panel is switched off for that tab); seeing it hide is manual — the test browser shows no real side panel |

## 14. Toolbar icon and badge

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| B-01 | Open one page three times and another once. Then close the duplicates. | The badge reads "3×" on each copy and nothing on the other tab; the icon's tooltip is "Tablight". After closing, no badge. | ui-popup-sidepanel.spec.ts › B-01 |
| B-02 | A suspicious tab is open. | "!" on every tab; tooltip "Tablight: 1 suspicious tab". | suspicious.spec.ts › a spam tab opened by another site… |
| B-03 | Click the Tablight icon in the toolbar (with "Toolbar icon opens" on Popup, then Side panel). | The popup opens; then the side panel opens. | manual — the browser's toolbar cannot be clicked by the test browser; S-30 checks what the button is set to |
| B-04 | Pin Tablight from the puzzle-piece menu. | The icon stays in the toolbar; the welcome card stops showing the pin tip. | manual — the browser's own menu |
| B-05 | Press Alt+Shift+T, then Alt+Shift+S. | The dashboard opens (or comes to the front); the side panel opens. | manual — browser keyboard shortcuts are not delivered to pages by the test browser |

## 15. First run and the guided tour

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| O-01 | Install Tablight. | The dashboard opens by itself with the interests step, "What do you browse most?" (the "Welcome to Tablight" card comes after it). | ui-onboarding-keyboard.spec.ts › O-01 |
| O-02 | Past the interests step, read the welcome card; click **Got it**; reload. | Three privacy points plus "Pin Tablight…" (while the icon is not pinned). The card goes and stays gone. | ui-onboarding-keyboard.spec.ts › O-02 |
| O-03 | Click **Auto-pause tabs unused for 1 hour**. | "Auto-pause is on: tabs unused for an hour will pause"; the card goes; Settings shows 1 hour. | ui-onboarding-keyboard.spec.ts › O-03 |
| O-04 | Click **Take the tour**, then **Skip tour**. | The tour starts at "1 of 13"; skipping also dismisses the card. | ui-onboarding-keyboard.spec.ts › O-04 |
| O-05 | Install from the Chrome Web Store / Edge Add-ons. | Same as O-01. | manual — store install |
| O-06 | On a fresh install's interests step: Tab between the topic chips, Space to toggle; type a 61-character name in **Add your own** and press Enter, then "Woodworking"; pick Movies and Sports; **Continue**. | One chip per topic, none pressed. Tab moves chip to chip, Space toggles it. The long name is refused with "Name must be 1-60 characters"; "Woodworking" becomes a removable chip; the field says "Learns from tabs you move into it.". Continue: "Added 2 groups" (Movies existed), Sports and Woodworking appear, installed groups nobody picked or used (e.g. News) go, and the welcome card follows. | ui-onboarding-keyboard.spec.ts › O-06 |
| O-07 | On a fresh install's interests step, click **Skip**. | Every group stays; the welcome card follows. | ui-onboarding-keyboard.spec.ts › O-07 |
| O-08 | Update from a version without the interests step: open All tabs; **Skip** the card; reload. Then Settings → General → **Choose your interests** → pick Sports → **Continue**. | A one-time card, "New: choose your interests", on All tabs only; the groups you have are pressed and can't be unselected. Skip hides it for good. The same step opens from Settings in a dialog: "Added 1 group", Sports appears, no group goes. | ui-onboarding-keyboard.spec.ts › O-08 |
| T-01 | Click the **?** (Guided tour) button from Saved for later. Go through with **Next**, use **Back** once, finish with **Done**. | It switches to All tabs. 13 steps, "N of 13", each with its title; steps about something on the page outline it, the others dim the page; Back is greyed out on step 1; the last step says Done/Close; afterwards the ? button has the focus. | ui-onboarding-keyboard.spec.ts › T-01 |
| T-02 | In the tour press →, →, ←; press Tab four times and Shift+Tab; press Esc. | Steps move; focus cycles Skip → Back → Next inside the card; Esc ends the tour. | ui-onboarding-keyboard.spec.ts › T-02 |
| T-03 | Settings → **Start the tour**. | All tabs, tour at step 1. | ui-onboarding-keyboard.spec.ts › T-03 |
| T-04 | Make the window narrow (under 900 px) and start the tour. | Steps about the hidden sidebar show a centred card that fits the window. | ui-onboarding-keyboard.spec.ts › T-04 |

## 16. Keyboard and accessibility

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| K-01 | On the dashboard press `/`; type "a/b"; empty the box and press ↓. | The search box gets the focus (the `/` is not typed); inside the box `/` is a normal character; ↓ moves to the first tab. | ui-onboarding-keyboard.spec.ts › K-01 |
| K-02 | In the list use ↓, End, ↑, Home; Space; Shift+↓ twice; Esc; Delete on a tab; Enter on a tab. | Focus moves row by row and jumps to the ends; Space selects; Shift+↓ extends the selection to 3; Esc clears it; Delete closes the focused tab ("Closed 1 tab"); Enter switches to the tab. | ui-onboarding-keyboard.spec.ts › K-02 |
| K-03 | Open a dialog (Rename group): Esc. Open Delete all data: Tab, Tab, Shift+Tab, click outside. | The name field has the focus; Esc closes and the focus returns to the button. A risky question starts on Cancel, Tab stays inside, the page behind cannot be used, clicking outside closes it and the focus returns. | ui-onboarding-keyboard.spec.ts › K-03 |
| K-04 | Make the window narrow (under 900 px). | The sidebar becomes a "View" menu listing views and groups (with counts); choosing one switches. | ui-onboarding-keyboard.spec.ts › K-04 |
| A-01 | With a screen reader (or the browser's accessibility panel) go over every view, the selection bar, the popup and the side panel. | Every button, link and field has a name (icon buttons too). | ui-onboarding-keyboard.spec.ts › A-01 (names only; listening with a real screen reader is manual) |

## 17. Light and dark

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| TH-01 | Settings → Theme **System**, with your computer in light mode, then dark mode. | Dashboard, popup and side panel follow the computer. | ui-settings.spec.ts › TH-01 (System × light / dark; the computer's setting is emulated) |
| TH-02 | Theme **Light** with the computer in dark mode (and in light mode). | Everything stays light; kept after a reload. | ui-settings.spec.ts › TH-01 (Light × light / dark) |
| TH-03 | Theme **Dark** with the computer in light mode (and in dark mode). | Everything is dark; kept after a reload. | ui-settings.spec.ts › TH-01 (Dark × light / dark) |
| TH-04 | With Theme on System, switch the computer between light and dark while Tablight is open. | Tablight follows at once. | manual — the operating system's own switch; TH-01 emulates the result |
| TH-05 | Look over every screen in dark mode. | Text is readable, nothing is white-on-white. | manual — visual judgement |

## 18. Other browsers

| ID | Steps | Expected result | Automated by |
|----|-------|-----------------|--------------|
| X-01 | Repeat sections 1, 11, 12 and 13 in Microsoft Edge. | Same results. | manual — the automated runs use Chromium only |
