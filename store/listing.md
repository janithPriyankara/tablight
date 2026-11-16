The same zip (`release/tab-organizer-<version>.zip`) goes to both stores.
Tab Organizer (placeholder; the owner chooses the final name)
Group, search and stash hundreds of tabs by topic. Runs on your device; no data leaves your computer.
Tab Organizer helps when you have too many tabs open.
- See all your tabs from every window in one dashboard, automatically grouped by topic such as Movies, Programming, Shopping or News. Drag a tab into another group and it learns your choice.
- Find duplicates and close the extras, with a 10 second undo.
- Put tabs to sleep to free memory, or stash a tab, a group or a whole window: the tab closes and the link is kept until you open it again.
- Hourly snapshots of your windows let you continue where you left off after a restart.
- Search by words (typos are fine) or by meaning.
- Export and import a backup file. Stashed tabs can sync between your own devices through your browser account.
Private by design: the grouping model is bundled in the extension and runs on your computer. The extension makes no network requests, has no accounts or analytics, never reads page contents and ignores private (incognito) windows.
Organize the user's open browser tabs: list, group by topic, find duplicates, sleep or stash them, and search them.
| Permission | Why it is needed |
|---|---|
| `tabs` | Read the title and address of open tabs to list and group them; switch to, sleep, close and create tabs when you ask. |
| `storage` | Keep groups, stashed tabs, snapshots and settings on the device, and sync the stash through the browser's extension sync storage. |
| `unlimitedStorage` | Store the tab index and the numeric summaries (embeddings) of tab titles locally, which can exceed the default quota with thousands of tabs. |
| `alarms` | Run auto-sleep (off by default) and hourly snapshots while the background worker is idle. |
| `offscreen` | Run the bundled on-device model in an offscreen document, because a service worker cannot host it reliably. |
| `favicon` | Show site icons from the browser's own icon cache; no icon is downloaded from a website. |
| `tabGroups` (optional) | Requested only if the user turns on mirroring of groups into the browser's native tab groups. |
No host permissions, no content scripts, no remote code.
- Collects personal data: No. Nothing is sent to the developer or any third party.
- Sells or transfers user data to third parties: No.
- Uses or transfers data for purposes unrelated to the single purpose, or for creditworthiness or lending: No.
- Remote code: No; the model and all code are in the package.
- Processing: on device only. Tab titles and addresses are processed locally by the bundled model.
- Browser sync: if the user leaves sync on (default), stashed tabs (address, short title, group name, date) are stored in the user's own browser sync storage (Microsoft account in Edge, Google account in Chrome). The developer cannot see it. It can be turned off in Settings.
- Encryption in transit and user-deletable data: nothing is transmitted by the extension; data is deleted by removing the extension or from Settings.
`https://<owner-github-username>.github.io/<repo>/privacy.html` (placeholder: the owner publishes `public/privacy.html` on their GitHub Pages site and replaces this).
