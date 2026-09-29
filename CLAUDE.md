# CLAUDE.md — Project rules for the Restaurant Billing PWA

Full spec: `plan.txt`. Architecture, data model, and phases: `PLAN.md`. Read both before working.

## Workflow
- Build in the phases listed in PLAN.md §10. Commit after each phase with a clear message.
- After every UI phase, run the dev server and capture screenshots at 375px and 1280px.
  Check the console for errors, and fix anything broken before moving on.
- When summarizing to the user, follow every technical term with a short plain-English
  explanation in brackets.
- Don't add runtime dependencies beyond `idb` unless PLAN.md is updated with a justification first.

## Hard constraints
- **Two modes** (owner request, 29 Sep 2026):
  - **Local-only** is the default while `cloud.config.json` is empty. There is no login and no network: each phone keeps its own data.
  - **Shared database** uses Supabase (free plan) when `cloud.config.json` has the URL and anon key.
    - Everyone signs in with a User ID and password, and fingerprint unlock works through WebAuthn.
    - The app talks only to that one Supabase project (the CSP `connect-src` is set at build time).
    - Sync is offline-first: see `supabase/README.md` and `src/cloud/`.
  - **Super admin** (owner request, 30 Sep 2026): `staff.role` is `super_admin` or `staff`. The Tikka Bites account (User ID `owner`) is the super admin.
    - Only the super admin sees **Settings → Users** (`src/cloud/usersSection.ts`): add a user, change a password, remove a user.
    - Accounts are created and deleted by the Edge Function `supabase/functions/staff-admin`, the only code that uses the secret key (Supabase injects it on the server).
    - Its first call is always an SQL check as the caller (`staff_add_prepare` / `staff_user_id` / `staff_remove`). Keep authorization in SQL, never in the function.
    - The function is deployed with "Verify JWT" off. It's a single file with no imports, so it can be pasted into the dashboard editor.
- No paid services, no analytics, and no other external calls. Cloud code stays lazy-loaded (`src/cloud/boot.ts`); local-only mode must not load it.
- Never ship or commit the Supabase `service_role` / secret key. `resolveCloudConfig` refuses it.
- Supabase blocks any DELETE or UPDATE without a WHERE clause on app requests (safeupdate). Write `where true` for a full-table delete; `tests/unit/schema.test.ts` checks this.
- Stack: Vite + vanilla TypeScript (strict). No React or any other UI framework.
- All data is stored in IndexedDB through `idb`.
- The initial JS must be **≤ 60 KB gzipped**. `npm run build` enforces this through `scripts/check-size.mjs`.
- The Reports screen must stay lazy-loaded with a dynamic `import()`.
- The app must keep working offline as a PWA.

## Money
- Store money **only** as integer paise, and percentages as integer basis points (1% = 100).
- Never use floats for money math. Use the helpers in `src/core/money.ts` and `src/core/totals.ts`.
- **No tax / GST anywhere** (local business): total = subtotal − discount (+ round-off). Don't add GST fields back.
- `formatINR()` is the only place that converts paise to a ₹ string, and only for display.
- Bills store snapshots (item name, price, cheesy line). Never recompute an old bill from the current menu.

## Branding (Tikka Bites)
- Use colour tokens from `src/styles/tokens.css` only. Button hover uses `--accent-hover`; red text uses `--accent-strong`. Check new colour pairs for WCAG AA in both themes.
- The menu keeps menu-card order (categories by first-added id), so don't sort categories alphabetically.
- No dish photos (removed at the owner's request); don't add them back. Photos stored by older versions are dropped at startup (`dropLegacyDishPhotos` in `db/db.ts`), and old backups that contain them still restore.

## Scope decisions (owner requests)
- Payment modes are **Cash and UPI only**. Don't add Card back; `'card'` exists only so old bills stay readable.
- **Excel `.xlsx` is the only export format** (`src/core/xlsx.ts`). Don't add CSV back.
- Receipts are shared as a **phone-size PDF** (360 × 780 pt, portrait) through the Web Share API, with a download fallback. It's drawn on a canvas (`ui/receipt/receiptPdf.ts`) and written by the hand-made `core/pdf.ts`. Don't add a PDF library.
- Every date uses local time (IST). New date logic needs a case in `tests/unit/month.test.ts`.
- Asset paths must work under a sub-folder (GitHub Pages). Use `assetUrl()` for built-in images and never hard-code `/…` URLs.

## Security
- **Never** use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `document.write`.
  Build DOM with `h()` from `src/ui/dom.ts`, `textContent`, and `createElement`. A unit test enforces this.
- No inline scripts or styles, and no `setAttribute('style', …)`, because CSP forbids `'unsafe-inline'`.
- Validate every input through `src/core/validate.ts`: lengths, ranges, and integer checks.
- Backup import must reject unknown keys and wrong types or ranges.
- Keep the headers in `netlify.toml` and `vercel.json` identical.

## Data integrity
- Receipt numbers (`RCPT-YYYYMM-NNNN`) come from exactly one place:
  - Local-only mode: the `saveBill` IndexedDB transaction.
  - Shared mode: the server's `save_bill()`.
  - Old `INV-` numbers stay valid everywhere and share the monthly counter.
- Shared mode, no internet: bills are saved with a temporary `OFF-<phone>-NNNN` number and queued in `meta.outbox`.
  - They upload as `offline: true`, keeping their sale time and the price charged, and are replaced by the server's bill.
  - Each sync uploads first, then downloads (so a lost reply is never counted twice).
- **Only 3 months are kept:** the current month and the 2 before it.
  - Server: `purge_old_months()` (pg_cron nightly, and on app start).
  - Every phone: `db/retention.ts#purgeOldMonths`, using `keepFrom` from the server in shared mode.
  - New date logic needs a case in `tests/unit/month.test.ts`.
- Every bill save or void must update `monthlyStats` in the **same** transaction.
- Dishes that appear in any bill are soft-deleted only. Voided bills are kept but excluded from totals.

## Performance
- Use event delegation for lists and grids, and batch DOM writes with `requestAnimationFrame`.
- Reports use indexed range queries and the `monthlyStats` fast path. Never load all bills into memory.
- The app must stay smooth with 50,000+ bills. Use `scripts/gen-backup.mjs` (restore the file in Settings) to test that.

## Commands
- `npm run dev`: dev server
- `npm run build`: type-check, build, and size budget check
- `npm test`: Vitest unit tests
- `npm run e2e`: Playwright end-to-end tests (local-only mode)
- `npm run e2e:cloud`: shared-database end-to-end tests.
  - The real app runs against the real SQL through `scripts/fake-supabase.mjs`.
  - Needs PostgreSQL 15+ (set PGHOST, PGPORT, PGUSER, and PG_BIN if psql isn't on PATH).
- `bash supabase/tests/run.sh`: SQL tests for `supabase/schema.sql` (same PostgreSQL)
