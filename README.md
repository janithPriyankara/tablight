A browser extension for Microsoft Edge and Google Chrome (desktop) that keeps large numbers of open tabs under control.
- Lists every open tab in one dashboard and groups them by topic (Movies, Programming, Shopping, ...). Grouping uses a small AI model that ships inside the extension and runs on your computer.
- Finds duplicate tabs and closes the extras (with undo).
- Pauses tabs to free memory (they stay in your tab strip), or saves them for later (closes the tab, keeps it in a list) and opens them again when you want.
- Saves a snapshot of your windows every hour and on startup, so you can pick up where you left off.
- Searches by words (typo tolerant) and by meaning.
- Backs up and restores your saved tabs with an export/import file. Saved tabs can sync between your own devices through your browser account.
Nothing leaves your device. The extension makes no network requests, has no servers, accounts or analytics, and never reads page contents (only each tab's title and address). The one exception you control is the optional sync of saved tabs through your browser's own extension sync. See [public/privacy.html](public/privacy.html) for the full statement.
Requires Node 20 or newer.
```
npm ci
npm run prepare:assets   # downloads the pinned model (checksum-verified) and copies the ONNX Runtime files
npm run build            # builds dist/ and runs the release checks
```
Load it unpacked:
- **Edge:** open `edge://extensions`, turn on Developer mode, choose Load unpacked, and pick the `dist` folder.
- **Chrome:** open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and pick the `dist` folder.
Press `Alt+Shift+T` to open the dashboard.
```
npm test                 # unit tests
npm run test:quality     # classification accuracy on the fixtures
npx playwright install chromium
npm run build
npm run test:e2e         # loads dist/ in real Chromium, checks flows, performance and that no network request is made
```
```
npm run package
```
This runs the release checks again and writes `release/tab-organizer-<version>.zip`. Upload that same zip to the Chrome Web Store and to Edge Add-ons. Store text and permission justifications are in [store/listing.md](store/listing.md). The build fails if the manifest permissions or CSP change, an unexpected URL appears in the code, a model file hash differs, a DOM-injection API appears in app code, a bundled package has a license outside MIT / Apache-2.0 / BSD / ISC / 0BSD, or the package is 45 MB or larger.
- Desktop browsers only.
- Edge and Chrome do not sync with each other. Use export/import to move your saved tabs between them.
- Grouping works best for English titles.
- If a device stays offline for more than 30 days, tabs you removed from Saved for later on another device may reappear there.
- Browser sync has a small quota: roughly 600 to 900 saved tabs sync; the rest stay on the device they were saved on (the app says so).
