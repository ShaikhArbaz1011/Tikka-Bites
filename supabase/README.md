# Shared database (Supabase): setup guide

With the shared database on:
- **Every phone uses the same data:** one menu, one list of bills and one receipt counter, so two phones never print the same number.
- **Everyone signs in** with a **User ID and password**. On a phone with a fingerprint sensor (or Windows Hello on a PC), the app can then be unlocked with the fingerprint.
- **Billing never stops.** With no internet, a bill is saved on the phone with a temporary number (`OFF-K7Q-0001`). When the internet is back it uploads and gets its final `RCPT-` number, and the receipt keeps a "Printed as OFF-…" line.
- **Only 3 months are kept:** this month and the 2 before it. On the 1st of each month the oldest month is deleted, from the shared database and from every phone. In the last 7 days of a month the app reminds you to **download that month's Excel** first.

Until `cloud.config.json` (in the project folder) is filled in, the app works exactly as before: each phone keeps its own data, with no sign-in.

---

## Set it up (owner, about 15 minutes, free)

### 1. Create the Supabase account with your email (not GitHub)
1. Open **https://supabase.com** and click **Start your project**.
2. Choose **Sign up with email**, not "Continue with GitHub". Enter your email and a password, then confirm the email Supabase sends you.
3. Click **New project**:
   - **Name:** `tikka-bites`
   - **Database password:** click *Generate a password* and **save it somewhere safe**. You won't need it day to day.
   - **Region:** *South Asia (Mumbai)*, the closest to Thane.
   - **Plan:** Free.

   Then click **Create new project** and wait about 2 minutes.

### 2. Create the database tables
1. In the left menu open **SQL Editor**, then click **New query**.
2. Open the file `supabase/schema.sql` from this project, copy **all** of it, paste it in, and click **Run**. It should end with "Success".
   - If it mentions **pg_cron** (the nightly clean-up): open **Database → Extensions**, switch on **pg_cron**, then run `schema.sql` again. Running it again is always safe.
   - Without pg_cron the app still clears old months itself when it starts.

### 3. Stop strangers from signing up
Open **Authentication → Sign In / Providers** and turn **off** "Allow new users to sign up".
Only the accounts you create can then sign in.

### 4. Create the accounts
For each person (you, and each counter phone or staff member):
1. Open **Authentication → Users → Add user → Create new user**.
2. Enter an **email** and a **password**, and tick **Auto Confirm User**.
   - The email is never shown to staff; they type a short User ID instead. You can use your own Gmail with a `+` label for each account: `yourname+owner@gmail.com`, `yourname+counter1@gmail.com`. Gmail treats them all as yours, so no new mailboxes are needed.
   - Use strong passwords, at least 10 characters.
3. Give the account its **User ID** and access. In the **SQL Editor**, run one line per account:
   ```sql
   select public.allow_staff('yourname+owner@gmail.com', 'owner');
   select public.allow_staff('yourname+counter1@gmail.com', 'counter1');
   ```
   The second value is the User ID typed on the sign-in screen: small letters, numbers, `.`, `-` or `_`.

   To take someone's access away:
   ```sql
   select public.remove_staff('counter1');
   ```

### 4b. Add users from the app (super admin)
Once this is set up, the owner can add, change and remove users in the app. This replaces
steps 4.1–4.3 for everyone after the first account.
1. Make the owner's account the **super admin** in the **SQL Editor**:
   ```sql
   select public.make_super_admin('owner');
   ```
2. Install the small server function that creates the sign-in accounts. It needs the project's secret key, which Supabase gives it on the server, so the key never goes into the app:
   1. Open **Edge Functions → Deploy a new function → Via Editor**.
   2. Name it `staff-admin`, replace the sample code with **all** of `supabase/functions/staff-admin/index.ts`, and click **Deploy**.
   3. In the function's **Settings**, turn **off** "Verify JWT" (the old JWT check) and save. The database checks every request itself, and only the super admin gets through.
3. In the app, the super admin opens **Settings → Users**:
   - **Add a user:** type a User ID (e.g. `counter2`) and a password (at least 8 characters), then give both to that person.
   - **Change password:** for any staff member, or **Change my password** for yourself.
   - **Remove:** that person can no longer sign in, on any phone. Their bills stay.

   Other staff don't see this section, and the server refuses them if they try.

   New accounts get an email made from the super admin's own email with a `+label` (`yourname+counter2@gmail.com`). Nobody types it; staff sign in with the User ID.

### 5. Connect the app
Open **Project Settings → API** (on newer dashboards: **API Keys**) and copy these two values:
- **Project URL**, which looks like `https://abcdefgh.supabase.co`
- the **anon / publishable** key

Both are safe to share: the public key can do nothing without a staff sign-in.
**Never share the `service_role` / secret key.** The app's build refuses it anyway.

Put the two values in `cloud.config.json`:
```json
{
  "supabaseUrl": "https://abcdefgh.supabase.co",
  "supabaseAnonKey": "eyJ... or sb_publishable_..."
}
```
Then publish the app (`git add -A`, `git commit -m "Connect shared database"`, `git push`).
Or send the two values to Claude, who can do this step for you.

### 6. First use
1. On the **main phone**, the one that already has the menu and bills, open the app and sign in as `owner`.
2. The app offers to **set up the shared database from this phone**. It copies the menu, settings and the last 3 months of bills.
3. On every other phone, sign in with its User ID. It downloads the shared menu and bills.
   - If a phone had its own bills, the app first offers to download a backup of them.
4. Each phone offers **Unlock with fingerprint**. Say yes on the billing phones.

---

## Everyday notes
- **Status pill** in the menu bar:
  - **Synced:** all good.
  - **Offline · 2 waiting:** 2 bills will upload when the internet is back.
  - **1 not uploaded:** see **Settings → Account & sync**.
- **Menu, settings and voiding need the internet.** Billing and reports don't.
- **Free plan:** Supabase pauses a free project after about a week with **no use at all**.
  Daily billing keeps it active. If it ever pauses, open the dashboard and click **Restore project**.

## Security
- Row-level security is on for every table. The public key alone can read or change nothing.
- Only accounts on the staff list can read or write, even if sign-ups were left on by mistake.
- Only the **super admin** can add, change or remove users. The `staff-admin` server function asks the database first, as the person calling, and changes nothing unless the answer is yes. The secret key stays on Supabase's server.
- Bills can't be written directly:
  - `save_bill()` re-checks every price and total and issues the number.
  - `void_bill()` keeps voided bills for the audit trail.
- Offline bills keep their sale time and the price charged. They're refused if dated in the future, older than 35 days, or in a month already cleared.
- A reply lost on a bad connection can't create a second receipt: the retry carries the same reference and gets back the bill already saved.
- **Fingerprint unlock** guards opening the app on that phone (WebAuthn, the browser's standard for fingerprint and face checks, using the phone's own sensor; the fingerprint never leaves the phone). The password stays the real sign-in.

## Tests
- `tests/run.sh` checks the whole schema on a local PostgreSQL 15+ that imitates Supabase's roles, on Linux or Windows:

      PGUSER=postgres PGHOST=localhost bash supabase/tests/run.sh

- `npm run e2e:cloud` runs the real app against the real schema through `scripts/fake-supabase.mjs`, which needs the same PostgreSQL. It covers two phones, offline bills, fingerprint unlock, voids, the 3-month clean-up, and the super admin adding, changing and removing users (through the real `staff-admin` code).

## Keeping the free project awake

Supabase pauses a free project after **7 days** with no activity (for example, if the shop is closed for a week). To stop that, the GitHub job `.github/workflows/keep-supabase-awake.yml` runs every 6 days (the 1st, 7th, 13th, 19th, 25th and 31st, 09:00 India time). It calls `public.keep_alive()`, which saves one random 6-digit number in the `dummy` table (column `dummy_data`) and deletes it again straight away. The table stays empty, and the app never uses it.

- To run it by hand: GitHub → **Actions → Keep Supabase awake → Run workflow**.
- GitHub turns off scheduled jobs in a repository with no changes for 60 days. If that happens, open the Actions tab and click **Enable workflow**.
- If the project is paused anyway: Supabase dashboard → the project → **Resume project**. No data is lost.

## Nightly backup into Google Sheets

Supabase keeps only the last 3 months, and the free plan has no backups you can restore yourself. A Google script in the shop's own Google account copies everything into a Google Sheet every night, where every month is kept for good. It reads through `public.backup_pull()`, which is read-only and locked by a backup key; only the key's SHA-256 hash is stored here (`public.backup_access`).

Set-up steps: [`google-sheets/README.md` → Nightly backup of Supabase](../google-sheets/README.md#nightly-backup-of-supabase-while-the-app-uses-supabase).
