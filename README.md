# Tablight

Private AI tab organizer. A browser extension for Microsoft Edge and Google Chrome (desktop) that keeps large numbers of open tabs under control.
- Lists every open tab in one dashboard and groups them by topic (Movies, Programming, Shopping, ...). Grouping uses a small AI model that ships inside the extension and runs on your computer: [BAAI/bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) (MIT licence), fine-tuned by Tablight on its own synthetic labelled tabs (`tablight/bge-small-tabs-v1`, see [scripts/finetune](scripts/finetune/README.md)). How accurate it is, and how that was measured: [docs/accuracy.md](docs/accuracy.md).
- Finds duplicate tabs and closes the extras (with undo).
- Pauses tabs to free memory (they stay in your tab strip), or saves them for later (closes the tab, keeps it in a list) and opens them again when you want.
- Saves a snapshot of your windows every hour and on startup, so you can pick up where you left off.
- Searches by words (typo tolerant) and by meaning.
- Recognises about 60,000 well-known names (TV, films, games, music, anime, books, cars, sports, hardware) from an offline list built from [Wikidata](https://www.wikidata.org) (CC0), packaged with the extension and read only on your device. It is used only on the query of a search-engine results page or the title of a Wikipedia page, never on ordinary page titles. Order of steps: your rules, groups you taught by moving tabs, names, the model, neighbouring tabs.
- "Look it up" (optional, user-driven): for an Unsorted tab, asks Wikidata what the cleaned text is, after you confirm. Moving the tab to a suggested group teaches that group.
- Backs up and restores your saved tabs with an export/import file. Saved tabs can sync between your own devices through your browser account.
Nothing leaves your device, with two exceptions you control. The extension makes no network requests unless you click **Look it up** on an Unsorted tab and confirm; then one request goes to Wikidata's public search API (`www.wikidata.org`, run by the Wikimedia Foundation) carrying only the cleaned text you saw and could edit, with no cookies and no referrer. It is refused for non-web, local and sensitive tabs (banking, payments, sign-in, medical, legal, salary/tax, mail, calendar, documents), answers are cached on the device (up to 500), never synced, and removed by "Delete all data", and the button can be hidden in Settings. The extension has no host permissions (the CSP `connect-src` allows only `'self'` and `https://www.wikidata.org`), no servers, accounts, analytics or API keys, and never reads page contents (only each tab's title and address). The other exception is the optional sync, through your browser's own extension sync, of saved tabs and of the examples you taught your groups (the title and site of tabs you moved into a group), so your other devices group the same way. See [public/privacy.html](public/privacy.html) for the full statement.
Requires Node 20 or newer.

For automated builds on a Linux VM with Docker-hosted Jenkins, see [Jenkins setup](docs/jenkins.md). The root `Jenkinsfile` runs checks and produces a downloadable extension ZIP.
```
npm ci
npm run prepare:assets   # verifies the committed model's checksums and copies the ONNX Runtime files
npm run build            # builds dist/ and runs the release checks
```
Load it unpacked:
- **Edge:** open `edge://extensions`, turn on Developer mode, choose Load unpacked, and pick the `dist` folder.
- **Chrome:** open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and pick the `dist` folder.
Press `Alt+Shift+T` to open the dashboard.
```
npm test                 # unit tests
npm run test:quality     # classification accuracy on the fixtures
npm run test:benchmark   # the sealed accuracy benchmark (see docs/accuracy.md)
npm run train:head       # retrains src/classify/head.json (threshold chosen on scripts/finetune/calibration-bge-small-tabs-v1.json, the rows the model never trained on)
npx playwright install chromium
npm run build
npm run test:e2e         # loads dist/ in real Chromium, checks flows, performance and that no network request is made unless Look it up is confirmed
```
```
npm run package
```
This runs the release checks again and writes `release/tablight-<version>.zip`. Upload that same zip to the Chrome Web Store and to Edge Add-ons. Store text and permission justifications are in [store/listing.md](store/listing.md). The build fails if the manifest permissions or CSP change, an unexpected URL appears in the code, a model file hash differs, a DOM-injection API appears in app code, a bundled package has a license outside MIT / Apache-2.0 / BSD / ISC / 0BSD, or the package is 55 MB or larger.
- Desktop browsers only.
- Edge and Chrome do not sync with each other. Use export/import to move your saved tabs between them.
- Grouping works best for English titles.
- If a device stays offline for more than 30 days, tabs you removed from Saved for later on another device may reappear there.
- Browser sync has a small quota: roughly 550 to 800 saved tabs sync; the rest stay on the device they were saved on (the app says so).
