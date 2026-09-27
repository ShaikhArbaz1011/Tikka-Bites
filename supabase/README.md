# Shared database (Supabase)

**Status:** the database side is ready and tested (`schema.sql`, tests in `tests/`).
The app does not use it yet: the sign-in screen and sync are the next update. Until
`cloud.config.json` (project root) is filled in, every phone keeps its own data, exactly as before.

## What it gives you
One menu, one list of bills and one receipt counter for every phone. The database hands out
receipt numbers, so two phones can never print the same number.

## Set it up (owner, about 10 minutes)
1. Create a free project at https://supabase.com. Region: Mumbai (closest to Thane).
   Keep the database password somewhere safe.
2. **SQL Editor → New query**: paste all of `supabase/schema.sql` and press **Run**.
   Running it again is safe; do that after any app update that changes this file.
3. In the Authentication settings, turn **off** "Allow new users to sign up",
   so only people you add can sign in.
4. **Authentication → Users → Add user → Create new user** for each staff member
   (or one shared counter account). Tick **Auto Confirm User**.
5. Give each account access (SQL Editor):
   `select public.allow_staff('counter@example.com');`
   To take access away: `select public.remove_staff('counter@example.com');`
6. **Project Settings → API**: note the **Project URL** and the **anon / publishable** key.
   Never share or commit the **service_role / secret** key (the build refuses it anyway).

When the app update lands, those two values go into `cloud.config.json`.

## Security
- Row-level security is on for every table. The public key alone can read or change nothing.
- Only accounts on the staff list can read or write, even if sign-ups were left on by mistake.
- Bills can't be written directly: `save_bill()` re-checks every price and total against the
  menu and issues the number; `void_bill()` keeps voided bills for the audit trail.
- A reply lost on a bad connection can't create a second receipt: the retry carries the same
  reference and gets back the bill that was already saved.

## Tests
`tests/run.sh` checks everything on a local PostgreSQL 15+ that imitates Supabase's roles:

    PGUSER=postgres PGHOST=/tmp bash supabase/tests/run.sh
