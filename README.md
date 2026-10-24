# Herd Tracker

Phone app for the herd: animals, breeding, calving, bulls and the sales waitlist.
Works on Android and iPhone as an installed web app. Data lives in the farm's Google Sheet.

## Files
- `index.html`, `app.css`, `app.js` – the app
- `config.js` – the Google Sheet script address (change this if you redeploy the script)
- `sw.js` – lets the app open with no signal
- `manifest.webmanifest`, `icons/` – home-screen name and icon

## Putting it online (GitHub Pages + app.musgrovefarms.org)
1. In the `herd-tracker` repository: "uploading an existing file" → drag in everything *inside* this folder
   (including the `icons` folder) so `index.html` sits at the top level → Commit changes.
2. Settings → Pages → Branch: `main`, folder `/ (root)` → Save.
3. Custom domain: `app.musgrovefarms.org` → Save. When the DNS check is green, tick Enforce HTTPS.

## Installing on a phone
- **iPhone:** open the address in Safari → Share → Add to Home Screen.
- **Android:** open it in Chrome → ⋮ menu → Add to Home screen / Install app.
Then enter your name and the farm passcode once.

## Updating the app
Upload the changed files to the same GitHub repository. Phones pick up the new version the next time the app opens with signal.

## Market prices
- The Sheet's script checks Chehalis Livestock Market's website and the Capital Press
  "Selected Western livestock auctions" weekly roundup every 6 hours, and saves them in the Prices tab.
- The Market tab shows one card per sale barn, newest sale first, with ▲▼ vs. that barn's previous sale.
- "Check now" on the Market screen runs the check right away.
- If a site changes its layout, the Market screen shows a note and keeps the last good prices.

## How data saves
- Every change saves on the phone first, then goes to the Sheet.
- With no signal, a yellow banner shows how many changes are waiting. They send automatically when signal returns.
- Rows you paste into the Animals tab by hand get picked up and given an id automatically.
- Photos go into the "Herd Tracker Photos" folder next to the Sheet and stay private.
