# Settings page: tabs and less text

## Why

The Settings page reads "like a newspaper": seven sections in one long scroll, several paragraphs of fine print under
the sync switch, the privacy text three times, and the welcome card and list actions above it. The goal is a page you
can scan: each setting is a name and a control, and explanations stay out of the way until asked for.

## Goals

- Settings split into four tabs, each short enough to take in at a glance.
- At most one short line under a setting; longer explanations fold behind a "More about …" disclosure.
- Clear section and setting names.

## Non-goals and anti-goals

- No change to what any setting does, its stored value, or the popup and side panel.
- Nothing becomes harder to find than today: no setting may end up behind more than one click (the tab).
- No information lost: the fine print is folded, not deleted.

## Approaches

- A. Trim the single page in place.
- B. Split into tabs.
- C. Cards with every explanation behind a "Details" toggle.

Picked: **A + B hybrid**: B's tabs with A's trimming inside each tab. C hid even the short, helpful text.

## Design

Tabs, under the Settings title (a WAI-ARIA tablist; ← / → move between tabs):

- **General**: Grouping (create new groups automatically) · Tabs and memory (auto-pause, keep saved tabs after
  opening) · Appearance (theme, toolbar icon opens, show groups as tab groups, point out suspicious tabs).
- **Sync & backup**: sync switch and status, Export / Import, "More about sync" folding the existing fine print
  (what syncs, Edge vs Chrome, 30-day offline, backup contents).
- **Privacy & data**: one privacy line with the policy link; Delete all data in a red-outlined box.
- **Help & about**: guided tour, help and support, about, privacy policy, terms, licences, maker.

Wording: "Memory" → "Tabs and memory"; "Mirror groups as browser tab groups" → "Show groups as tab groups in the tab
strip". "Remove a saved tab from Saved for later when I open it" keeps its meaning.

Page chrome: on Settings, the welcome card and the Close duplicates / Re-group everything buttons are not shown.

Routing: the open tab is in the hash (`#view=settings&tab=sync`); General is the default; links and Back work.

## Left to the builder

Exact one-line texts, CSS for the tab strip (matching existing segmented controls and theme tokens), and keeping the
guided tour's Settings step and existing UI tests (S-xx) pointing at the right elements.
