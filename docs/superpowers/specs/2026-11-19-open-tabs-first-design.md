# Open tabs first, with a "Now" mark

## Why

The owner wants to find the tabs they are actually using and jump back quickly. Today the dashboard lists sort by
window first, then by last use, so a tab used a minute ago in window 7 sits below every window-1 tab, and paused tabs
are mixed in with open ones.

## Goals

- Every dashboard list (All tabs, each group, Unsorted, and the other views that use the default order) shows open
  tabs first, most recently used at the top, across all windows; then paused tabs, most recent first; then
  saved-for-later items as today (newest saved first).
- The tab that is active right now in each window gets a small **Now** chip, like the existing New / Paused chips.
- The list stays current: switching tabs refreshes an open dashboard (debounced, like other changes).

## Non-goals

- A separate "Open now" view (the owner preferred fixing the order where they already look).
- A Tablight browsing history (still an open question; the browser keeps one already).
- Changing the side panel's order (it already sorts open, then paused, then by last use).

## Approaches

- **Picked:** change the default order and add a Now mark. Fixes the problem where the owner already looks.
- Separate "Open now" view: another place to look; set aside.
- Keep the window order and only add a mark: the active tab would still sit mid-list; set aside.

## Design

- `byDefaultOrder` (src/ui/dashboard/views.ts): rank by state (open, paused, saved), then open/paused by
  `lastActiveAt` descending, saved by `stashedAt` descending. Window no longer orders the list; rows still show
  "Window N".
- `DashboardState.activeTabIds: number[]`: the active tab of every window (`chrome.tabs.query({ active: true })`).
  The dashboard's own tab is not an item, so its window simply shows no Now mark.
- `ItemRow` gets `now?: boolean` and renders a `Now` chip (`state state-now`, existing chip styling and tokens; title
  "The tab you're on in this window").
- `activated()` in the background calls `notifyChanged()` after `touchTab`, so open pages refresh on tab switches.

## Left to the builder

Chip colour within existing tokens; whether the Duplicates view (sorted by address first) keeps its own order (it
does: only its tie-break uses the default order).
