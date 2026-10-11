# Tikka Bites in Google Sheets (shared database)

With this, every phone keeps the shop's data in **Google Sheets in the owner's own Google Drive**, instead of Supabase. The service is free and is never paused.

The data lives in three files, all inside one Drive folder called **Tikka Bites data**:

| File | What it is |
|---|---|
| **Tikka Bites – Control** | Holds the script (`Code.gs`), the **Tikka Bites** menu and a **Status** tab. No shop data. |
| **Tikka Bites – Main** | The file the app reads and writes. It has a tab for each month ("Bills 2026-10"), plus Menu, Cheesy lines, Settings, Users and Counters. It keeps this month and the 2 before it. |
| **Tikka Bites – Backup** | Every change is copied here straight after Main, in the same request. **Old months stay here for good.** |
| Nightly copies (folder) | A dated copy of Main, made every night at about 00:05 India time. The newest 14 are kept. |

> **Using Supabase?** The same script can instead keep a **nightly backup of Supabase** in Google Sheets. It doesn't change the app. See [Nightly backup of Supabase](#nightly-backup-of-supabase-while-the-app-uses-supabase) at the end of this page.

## Why the sheets don't get corrupted

- **One request at a time.** The script holds a lock, so two phones never write at the same moment, and nobody ever reads half a change.
- **Checked first, written after.** Every bill is checked again on the server: prices, totals, discount and round-off, using whole paise. Only then is anything written.
- **Receipt numbers can't repeat.** The number is reserved and saved before the bill row is written. If Google fails in the middle, a number may be skipped, but it is never used twice. If a phone sends the same bill again after a lost reply, it gets the bill that was already saved.
- **Hand edits are caught.** If someone moves, adds or deletes a column, or renames a tab, the script **stops writing** and the app says what changed. Phones keep billing offline (`OFF-…` numbers) until the change is undone.
- **Text stays text.** Phone numbers keep their leading 0, and a customer name can never turn into a formula. The exact data of every row is also kept as JSON (text data) in hidden **Data** columns, and the app trusts only those. The visible columns are only for reading.
- **Two files plus nightly copies.** If Main is ever damaged: open the Control sheet → **Tikka Bites → Switch the app to the Backup sheet**. Google also keeps its own *File → Version history* for every file.

## Set up (one time, about 15 minutes)

You need the shop's Google account (a normal Gmail account is fine). The script runs as this account and the files stay in its Drive. Staff never need a Google account: they sign in to the app with a User ID and password.

1. In Chrome, sign in to the shop's Google account. Open <https://sheets.new> to make a new spreadsheet and name it **Tikka Bites – Control**.
2. Choose **Extensions → Apps Script**. Name the project **Tikka Bites**. Delete the sample code, paste **all** of [`Code.gs`](Code.gs), and press **Ctrl+S**.
3. Click ⚙️ **Project Settings** and set the **Time zone** to *(GMT+05:30) India Standard Time*.
4. Go back to the Control sheet and reload the page. A **Tikka Bites** menu appears. Choose **Tikka Bites → Set up (first time)**.
   - Google asks for permission: **Continue**, then choose the shop's account.
   - It says *"Google hasn't verified this app"*. That is normal for your own script. Click **Advanced → Go to Tikka Bites (unsafe) → Allow**.
   - If Set up stopped at the permission screen, choose it once more. You will see *"Set up done"*, and the **Tikka Bites data** folder will be in your Drive.
5. **Tikka Bites → Create or reset the owner login.** Type the User ID (for example `owner`) and a new password (at least 8 characters). This is the **super admin**: the only person who can add staff in the app.
6. In Apps Script, choose **Deploy → New deployment**. Click the ⚙️ next to *Select type* and choose **Web app**, then set:
   - Execute as: **Me**
   - Who has access: **Anyone**

   Click **Deploy**, then copy the **Web app URL**. It ends with `/exec`.
7. **Tikka Bites → Run the self-test.** It uses two temporary sheets, never your real ones, and moves them to the trash afterwards. It should say *"Self-test passed."*
8. Put the address into `cloud.config.json` and publish the app:
   ```json
   "backend": "sheets",
   "sheetsUrl": "https://script.google.com/macros/s/…/exec"
   ```
9. On the phone that has the shop's current data, open the app and sign in as the owner, then tap **Set up from this phone**. This copies the menu, settings and the last 3 months of bills into the sheet. On every other phone, sign in and tap **Join**. Then add staff in **Settings → Users**.

> "Who has access: Anyone" only means a phone can reach the script without a Google account. Every request still needs a valid sign-in. Passwords are stored only as salted hashes (a scrambled form that can't be turned back into the password). Never share the Main or Backup file with staff.

## Changing the script later

Paste the new `Code.gs` and press Ctrl+S. Then choose **Deploy → Manage deployments**, click ✏️ (edit), set **Version → New version**, and click **Deploy**. The web app address **stays the same**, so the app needs no change.

If you make a **New deployment** instead, it gets a new address, and `sheetsUrl` would have to be updated.

## Every day

- The **Status** tab in the Control sheet shows the nightly report: Backup up to date, old months cleared from Main, the copy saved, and the check result.
- In the app, **Settings → Users** (owner only) shows *"Backup Google Sheet: up to date"*, or how many changes it is behind. It catches up by itself.
- **Tikka Bites → Check the sheets now** runs the same check at any time. It looks for damaged rows, repeated receipt numbers and counters that are behind, and checks that Main and Backup match.

## If something goes wrong

| What you see | What to do |
|---|---|
| The app says *"The Main Google Sheet was changed by hand (tab …)"* | Undo the edit (Edit → Undo, or File → Version history → restore). The phones keep billing offline and upload afterwards. |
| *"…has a damaged row…"* or Main looks broken | Control sheet → **Tikka Bites → Switch the app to the Backup sheet**. The app carries on with the same data and numbers. A fresh Backup is made, and the old Main is renamed "(damaged …)" and kept. |
| A file was deleted | Google Drive → **Trash** → Restore it. |
| You need yesterday's data | Open the folder **Tikka Bites data → Nightly copies**. |
| The owner forgot the password | Control sheet → **Tikka Bites → Create or reset the owner login**. |
| *"The Google Sheet is busy"* | Another phone was saving. The bill was saved on the phone and uploads by itself. |

## Free limits (Google, consumer account)

- At most 30 requests running at the same moment, and 6 minutes per request (one request takes about 1–2 seconds).
- 90 minutes a day of timed jobs. The nightly job takes about a minute.
- 10 million cells per file. Main only holds 3 months. The Backup grows by about 1 million cells a year at 150 bills a day, and the check warns at 8 million.
- 15 GB of Google Drive space, shared with Gmail.

## How it is tested

- **Unit tests:** `tests/unit/sheetsBackend.test.ts` runs `Code.gs` against [`tests/helpers/fakeAppsScript.mjs`](../tests/helpers/fakeAppsScript.mjs), which behaves like Google Sheets (number conversion, formulas, the 50,000-character cell limit, the lock). It covers every rule from the Supabase SQL tests, plus:
  - a crash after every single write
  - hand edits
  - an unreachable Backup
  - 300 random changes
  - switching to the Backup
- **App tests:** `tests/unit/sheetsClient.test.ts` runs the app's own code against the same script.
- **End to end:** `npm run e2e:sheets` runs the real app in a browser against `scripts/fake-sheets.mjs`.

## Nightly backup of Supabase (while the app uses Supabase)

The app keeps using Supabase as before; nothing changes on the phones. Every night, at about **3 am India time**, the script copies everything from Supabase into one Google Sheet, **Tikka Bites – Supabase backup**, in the **Tikka Bites data** folder:

- The tabs are the same as in the Backup above: a tab for each month ("Bills 2026-10"), plus Menu, Cheesy lines, Settings and Counters.
- **Every month stays here for good.** Supabase and the phones keep only the last 3 months, so this sheet is the only place older bills are kept, apart from Excel exports.
- **It only reads Supabase.** It asks `public.backup_pull()` (in `supabase/schema.sql`) for what changed since the last copy. That function can't change anything.
  - It needs a long random **backup key**, which only this script knows.
  - Supabase keeps just the key's SHA-256 fingerprint, so even the public key in the app can't read the data with it.
- **The same rules as the sheets above:**
  - Everything is checked before anything is written.
  - Each bill has one row, found by its receipt number.
  - Hand edits are caught.
  - If a copy stops halfway, the next run simply does it again, and nothing is doubled.
- **It checks itself.** After each copy it compares the number of bills of every month with Supabase. If some are missing (for example, rows deleted by hand), it copies everything again.
- **The Status tab** of the Control sheet says when the last copy ran and what it found. If a copy fails, Google emails the account owner.
- **No web app deployment is needed.** It only needs the **Allow** permission once.

### Set up (one time, about 10 minutes)

1. Sign in to the shop's Google account, open [sheets.new](https://sheets.new) and name the sheet **Tikka Bites – Control**.
2. Open **Extensions → Apps Script**.
   - Delete what is there and paste the whole of [`Code.gs`](Code.gs).
   - In **Project Settings** (the gear icon), set the time zone to **(GMT+05:30) India Standard Time**.
   - Save.
3. Reload the Control sheet. Choose **Tikka Bites → Supabase backup: set up**.
   - Google asks for permission. Click **Allow**; on the "Google hasn't verified this app" screen, choose **Advanced → Go to … (unsafe)**. The script is your own, so this is expected.
   - Paste the Supabase **project address** and the **anon / publishable key**. Both are in `cloud.config.json` and in Supabase → Project Settings → API. **Never paste the secret / service_role key**: the script refuses it.
4. The script shows one line, `select public.set_backup_key('…');`. The same line is also on the Status tab.
   - Paste it into **Supabase → SQL Editor** and click **Run**.
   - If `backup_pull` doesn't exist yet, run `supabase/schema.sql` first. It is safe to run again.
5. Choose **Tikka Bites → Supabase backup: copy now**. The message should end with "Checked: all … bills Supabase has are in the sheet."

From then on it runs by itself every night. Running **set up** again keeps the same key and the same file.

**If the Tikka Bites menu doesn't appear, or Extensions → Apps Script says "Page not found":** Chrome is signed in to several Google accounts and the shop's isn't the first one. Google has a known bug with this.
- Fix: open the sheet in a window signed in only to the shop's account (for example a separate Chrome profile).
- The nightly copy isn't affected: it runs on Google's side, not in the browser.
- The live set-up on 12 Oct 2026 worked around it from the script editor: Project editor → a temporary file → Run.

If the Supabase database is ever re-created, or you point it at another project, the script notices the new database and starts a new file, "… (from <date>)". The old file is kept as it is.

Tested by `tests/unit/supabaseBackup.test.ts` (including a run against the real SQL in a local PostgreSQL) and `supabase/tests/i_backup.sql`.
