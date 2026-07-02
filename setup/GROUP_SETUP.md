# New Group Setup — Google Sheet + Apps Script

One-time steps to wire each new group (`g1`, `g2`) so members can log in and submit
predictions for future rounds (R16 → Final). The already-played R32 first-8 picks are
already scored and shown — this is only needed for **future** rounds and per-group login.

Do this **once per group**. Files referenced live in `setup/`.

---

## 1. Create the Google Sheet

1. Go to https://sheets.google.com → **Blank spreadsheet**.
2. Name it e.g. `FIFA Group 1`.
3. **File → Import → Upload** → pick `setup/g1-roster.csv` (use `g2-roster.csv` for Group 2).
   - Import location: **Replace current sheet**. Separator: comma.
4. You now have a tab with columns: `id | name | email | Team 1..4`.
   - **Do not rename the `id`, `name`, `email` headers.** The `id` column is what keeps a
     player's picks attached even if you later fix their display name.
   - You *can* edit the `name` values (see “Fixing names” below). Leave `id` and `email` alone.

## 2. Add the Apps Script backend

1. In the sheet: **Extensions → Apps Script**.
2. Delete any boilerplate, paste the entire contents of `google-apps-script/Code.gs`.
3. Set this group's PIN — change line 6:
   ```js
   const STATIC_PIN = '5555';   // <-- change to THIS group's 4-digit PIN
   ```
   Use a different PIN per group.
4. **Save** (disk icon).

## 3. Deploy as Web App

1. **Deploy → New deployment → ⚙ → Web app**.
2. Execute as: **Me**. Who has access: **Anyone**.
3. **Deploy** → authorize when prompted → **copy the Web App URL**
   (looks like `https://script.google.com/macros/s/AKfy…/exec`).

## 4. Register the URL

Add the URL in **two** places so both the live site and the 10-min refresh use it:

- **GitHub** → repo **Settings → Secrets and variables → Actions → New repository secret**
  - Name: `APPS_SCRIPT_URL_G1` (or `APPS_SCRIPT_URL_G2`)
  - Value: the Web App URL
- **Vercel** → project **Settings → Environment Variables**
  - Same name/value, Production scope.

That's it. On the next refresh the group's `meta.appsScriptUrl` gets set, and login switches
from the offline fallback to Apps Script (enforcing that group's PIN).

---

## Before Apps Script is set up (offline mode)

Until step 4 is done, members can already log in with their **email + PIN `5555`**
(offline fallback matches the roster in the group's `app-data.json`). Predictions save to the
device only. Once Apps Script is wired, the per-group PIN applies and picks sync centrally.

## Fixing names

Forms collected no names, so display names were derived from emails (some are rough, e.g.
`Unairgmail`, `Ranjitn`). To fix:
1. Edit the `name` column in `data/groups/<id>/participants.json` (the source of truth).
2. Re-run `npm run refresh:groups`.
3. Re-export the roster CSV if you also want the sheet updated (names only — never touch `id`).

Because `id` is keyed on email, renaming is safe — picks stay attached.

## Security model / accepted tradeoffs

Deliberate tradeoffs for a ~30-person office pool on a static site — revisit only if the
audience changes:

- **Group login PINs are plaintext** in each group's public `app-data.json` (`meta.loginPin`),
  and member emails are exposed there too (both are needed for client-side login). Anyone who
  opens the JSON can read them.
- **Cross-group reads by URL guessing**: `/g1/app-data.json` and `/g2/app-data.json` are public;
  a member of one group can read another group's leaderboard/picks. True isolation would need an
  auth-gated backend, which this app intentionally doesn't have.
- **Apps Script `?action=export` returns live (unlocked) picks** — someone technical could peek
  at others' picks before a round locks. The app UI itself only reveals picks after lock.
- The destructive `?action=clear` endpoint **requires the group PIN and a participantId**
  (wipe-all removed) as of the July 2026 hardening — keep that check when editing Code.gs.

## Note on Ranjit

`ranjitn15@gmail.com` (group-stage form) vs `ranjitn15@yahoo.co.in` (knockout form) were treated
as the same person and merged under `ranjitn15`, canonical email `ranjitn15@gmail.com`. He logs in
with the gmail address. Change `email` in participants.json if that's wrong.
