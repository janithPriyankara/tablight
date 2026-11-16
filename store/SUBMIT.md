# Submitting Tab Organizer to the stores

Everything to upload is in this repo:

| What | File |
|---|---|
| Extension package (same zip for both stores) | `release/tab-organizer-0.1.0.zip` |
| Store text, permission reasons, privacy answers | `store/listing.md` |
| Screenshots, 1280×800 | `store/assets/screenshot-1…5-*.png` |
| Small promo tile, 440×280 | `store/assets/promo-small-440x280.png` |
| Marquee tile, 1400×560 (Chrome, optional) | `store/assets/promo-marquee-1400x560.png` |
| Store logo, 300×300 (Edge) | `store/assets/logo-300x300.png` |
| Privacy policy page | `public/privacy.html` (must be hosted at a public URL, step 1) |

Rebuild the zip after any change: `npm run build && npm run package`.

## 1. Host the privacy policy (both stores require a URL)

The source repo is private, so publish only the policy:

1. Create a new **public** GitHub repo, e.g. `tab-organizer-privacy`.
2. Add `public/privacy.html` to it as `index.html`.
3. Settings → Pages → Deploy from branch `main`, folder `/ (root)`.
4. The URL is `https://<your-username>.github.io/tab-organizer-privacy/`. Use it in both stores.

## 2. Microsoft Edge Add-ons (free)

1. Register at Partner Center: https://partner.microsoft.com/dashboard/microsoftedge/overview (individual account, no fee).
2. **Create new extension** → upload `release/tab-organizer-0.1.0.zip`.
3. **Availability:** Public, or Hidden to test with a link first. Markets: all.
4. **Properties:** category *Productivity*; privacy policy URL from step 1; "Does it access personal information?" Yes (tab titles and addresses), processed on device.
5. **Store listing (English):** description and short description from `store/listing.md`; logo `logo-300x300.png`; small tile `promo-small-440x280.png`; screenshots 1–5.
6. **Submit.** Review usually takes up to 7 working days.

## 3. Chrome Web Store ($5 one-time)

1. Register at https://chrome.google.com/webstore/devconsole and pay the $5 fee. Verify the contact email.
2. **New item** → upload the same zip.
3. **Store listing:** description, category *Productivity → Workflow & Planning*, language English; icon comes from the zip; screenshots 1–5; small promo tile; marquee tile (optional).
4. **Privacy practices:**
   - Single purpose: the "Single purpose" line in `store/listing.md`.
   - Permission justifications: the table in `store/listing.md`, one per permission.
   - Remote code: **No**.
   - Data usage: tick "Web history" (tab addresses) with the purpose "App functionality"; tick the three certifications (not sold, not used for unrelated purposes, not for credit).
   - Privacy policy URL from step 1.
5. **Distribution:** Public, or Unlisted to test with a link first.
6. **Submit for review.** Usually a few days; the on-device model and the `tabs` permission can make it longer.

## 4. After approval

- Install it from the store in both browsers and run through: grouping, duplicates, sleep, stash, sync between two signed-in devices.
- Note the extension IDs. Admins need them to force-install it on managed machines (`ExtensionInstallForcelist` policy, via Group Policy, Intune, Google Admin or Jamf).
- For updates: bump `version` in `package.json`, rebuild, package, and upload the new zip to each store. Installed copies update automatically.
