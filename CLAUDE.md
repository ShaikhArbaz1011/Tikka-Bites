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
- There is no login, no accounts, no backend, no paid services, and no external network calls or analytics.
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

## Security
- **Never** use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, or `document.write`.
  Build DOM with `h()` from `src/ui/dom.ts`, `textContent`, and `createElement`. A unit test enforces this.
- No inline scripts or styles, and no `setAttribute('style', …)`, because CSP forbids `'unsafe-inline'`.
- Validate every input through `src/core/validate.ts`: lengths, ranges, and integer checks.
- Backup import must reject unknown keys and wrong types or ranges.
- Keep the headers in `netlify.toml` and `vercel.json` identical.

## Data integrity
- Bill numbers (`INV-YYYYMM-NNNN`) are generated only inside the `saveBill` IndexedDB transaction.
- Every bill save or void must update `monthlyStats` in the **same** transaction.
- Dishes that appear in any bill are soft-deleted only. Voided bills are kept but excluded from totals.

## Performance
- Use event delegation for lists and grids, and batch DOM writes with `requestAnimationFrame`.
- Reports use indexed range queries and the `monthlyStats` fast path. Never load all bills into memory.
- The app must stay smooth with 50,000+ bills. Use `scripts/seed-bills.ts` to test that.

## Commands
- `npm run dev`: dev server
- `npm run build`: type-check, build, and size budget check
- `npm test`: Vitest unit tests
- `npm run e2e`: Playwright end-to-end tests
