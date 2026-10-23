# Herd Tracker

Phone app for the herd: animals, breeding, calving, bulls and the sales waitlist.
Works on Android and iPhone as an installed web app. Data lives in the farm's Google Sheet.

## Files
- `index.html`, `app.css`, `app.js` – the app
- `config.js` – the Google Sheet script address (change this if you redeploy the script)
- `sw.js` – lets the app open with no signal
- `manifest.webmanifest`, `icons/` – home-screen name and icon

## Putting it online (GitHub Pages)
1. Make a free account at github.com.
2. New repository → name it `herd-tracker` → Public → Create.
3. "uploading an existing file" → drag in everything from this folder (including the `icons` folder) → Commit changes.
4. Settings → Pages → Branch: `main`, folder `/ (root)` → Save.
5. After a minute the address appears at the top of that page, e.g. `https://yourname.github.io/herd-tracker/`.

## Installing on a phone
- **iPhone:** open the address in Safari → Share → Add to Home Screen.
- **Android:** open it in Chrome → ⋮ menu → Add to Home screen / Install app.
Then enter your name and the farm passcode once.

## Updating the app
Upload the changed files to the same GitHub repository. Phones pick up the new version the next time the app opens with signal.

## How data saves
- Every change saves on the phone first, then goes to the Sheet.
- With no signal, a yellow banner shows how many changes are waiting. They send automatically when signal returns.
- Rows you paste into the Animals tab by hand get picked up and given an id automatically.
- Photos go into the "Herd Tracker Photos" folder next to the Sheet and stay private.
