# PLAN.md — Restaurant Billing PWA

A single-page, offline-first restaurant billing app. No login, no server, no paid
services. All data lives in the browser (IndexedDB). Deploys free on Netlify or Vercel.

> Status: **APPROVED** (defaults accepted).
>
> **Change from plan.txt:** no tax / GST at all. This is a local business, so bills show
> subtotal − discount (+ round-off) = total. There is no GST %, no CGST/SGST, and no GSTIN.

---

## 1. Design source

`/design` does not exist in the repo, and the frontend-design plugin is not
available in this environment. I will design the look myself using these rules:

- **Look:** warm and clean. Off-white background, a single saffron/orange accent
  (`#E8590C`), dark slate text, and green/red dots for veg/non-veg (the Indian FSSAI convention).
- **Type:** the system font stack only. Web fonts would mean network calls and extra weight.
- **Touch:** every tap target is at least 44×44 px, and the main actions are within thumb reach on phones.
- **Layout:**
  - **Desktop (≥ 1024px):** left side-nav, then a category rail, then the menu grid, then a cart
    panel pinned to the right. This is the classic POS layout.
  - **Tablet (640–1023px):** the menu grid and the cart panel sit side by side, and the nav becomes an icon rail.
  - **Phone (< 640px):** a bottom tab bar and a full-width menu grid. A sticky "cart bar"
    (item count + total) opens a full-height cart sheet.
- Light theme first. A dark theme follows `prefers-color-scheme` through CSS variables. This is cheap to add.

If you later add screenshots to `/design`, I'll re-skin to match them. Only the CSS variables and
layout CSS change; the logic stays the same.

---

## 2. Architecture

```
┌──────────────────────────── Browser ────────────────────────────┐
│  index.html  ──►  main.ts (bootstrap, hash router, persist())   │
│                     │                                            │
│     ┌───────────────┼──────────────┬───────────────┐             │
│     ▼               ▼              ▼               ▼             │
│  ui/billing      ui/menu       ui/settings    ui/reports (lazy)  │
│     │               │              │               │             │
│     └──────► core/ (pure functions: money, totals, billNo,         │
│               shuffleBag, topK, validate, csv, dates)            │
│                     │                                            │
│                     ▼                                            │
│               db/ repositories  ──►  IndexedDB (via `idb`)       │
│                                                                  │
│  sw.js (service worker) caches the app shell → works offline     │
└──────────────────────────────────────────────────────────────────┘
```

- **Stack:** Vite + vanilla TypeScript (`strict: true`) with no framework.
- **Routing:** hash routes (`#/billing`, `#/menu`, `#/reports`, `#/settings`). They work on any
  static host with no server rules. The SPA fallback is still configured, as the plan requires.
- **Code split:** `ui/reports/*` is loaded with a dynamic `import()` the first time Reports opens.
- **Layers:**
  - `core/` is pure TypeScript with no DOM or DB access, so it is 100% unit-testable.
  - `db/` holds the only code that touches IndexedDB. It exposes typed repository functions.
  - `ui/` holds the screens. They build DOM with a tiny `h()` helper that only ever sets `textContent`.

### Runtime dependencies

| Package | Size (gz) | Why |
|---|---|---|
| `idb` | ~1.2 KB | Required by spec. Gives a Promise-based IndexedDB API. |

That is the only runtime dependency. Everything else (charts, CSV, shuffle, top-K, image
resize, service worker) is hand-written.

### Dev-only dependencies (these never ship to users)

`vite`, `typescript`, `vitest`, `fake-indexeddb` (lets unit tests run DB code in Node),
`@playwright/test` (end-to-end tests + screenshots).

### Bundle budget

- **Initial JS: ≤ 60 KB gzipped.** Target is ~30 KB.
- **Reports chunk:** loaded separately. Target is ~15 KB.
- A `scripts/check-size.mjs` script runs after `vite build` and **fails the build** if the budget is exceeded.

---

## 3. Data model (IndexedDB database `restobill`, version 1)

**Money rules**
- All money is an integer number of **paise**.
- All percentages are integers in **basis points** (1% = 100 bp). This keeps floats out of the math completely.

### Store `menu` (key: auto-increment `id`)

```ts
{
  id: number,
  name: string,          // 1–60 chars
  nameLower: string,     // precomputed for search
  category: string,      // 1–30 chars
  pricePaise: number,    // integer, 1 … 10,000,000 (₹1 lakh)
  isVeg: boolean,
  active: boolean,       // disabled dishes are hidden from billing
  deleted: boolean,      // soft delete: never removed if used in bills
  createdAt: number, updatedAt: number
}
```
Indexes: `category`, `active`.

- **Hard delete** is allowed only if the dish never appeared in any bill.
  This is tracked with a `usedInBills` flag, which is set when a bill is saved.

### Store `bills` (key: `billNo`, e.g. `INV-202609-0001`)

```ts
{
  billNo: string,
  createdAt: number,          // epoch ms
  monthKey: string,           // "202609"
  hour: number, weekday: number,   // precomputed for peak-hours / best-days
  items: Array<{ menuId, name, category, isVeg, unitPaise, qty, linePaise }>,
                              // name/price SNAPSHOT: later menu edits don't change old bills
  orderType: 'dine-in' | 'takeaway' | 'delivery',
  tableNo?: string,
  customerName?: string,
  paymentMode: 'cash' | 'upi' | 'card',
  discount: { kind: 'flat', paise } | { kind: 'pct', bp },
  subtotalPaise, discountPaise,
  roundOffPaise,              // see Open Question 2
  totalPaise,
  itemCount: number,
  categories: string[],       // distinct categories in bill, for filtering
  hasVeg: boolean, hasNonVeg: boolean,
  cheesyLine: string,         // stored, so a reprint shows the SAME line
  status: 'paid' | 'void',
  voidReason?: string, voidedAt?: number
}
```
Indexes: `createdAt`, `monthKey`, `status`, `totalPaise`.

### Store `counters` (key: `monthKey`)

```ts
{ monthKey: "202609", last: 17 }
```

### Store `monthlyStats` (key: `monthKey`), pre-aggregated

```ts
{
  monthKey, billCount, voidCount,
  revenuePaise, discountPaise, itemsSold,
  byPayment:   { cash: {count, paise}, upi: {...}, card: {...} },
  byOrderType: { 'dine-in': {...}, takeaway: {...}, delivery: {...} },
  byCategory:  { [category]: { qty, paise } },
  byDish:      { [menuId]: { name, qty, paise } },
  byHour:      number[24],   // revenue paise per hour of day
  byWeekday:   number[7],
  byDay:       { [1..31]: paise }
}
```

### Store `settings` (single record, key `"app"`)

```ts
{ name, address, phone, logoDataUrl?, currencySymbol,
  receiptWidth: '58' | '80' | 'A4', roundOff: boolean, lastBackupAt?: number }
```

### Store `cheesyLines` (key: auto `id`)

```ts
{ id, text /* 1–120 chars */, builtIn: boolean, active: boolean }
```

### Store `meta` (key/value)

- `shuffleBag`: `{ order: number[], pos: number }`, which persists the bag across reloads.
- `schemaVersion`.

### The critical transaction: `saveBill()`

This is a single `readwrite` transaction over `counters`, `bills`, `monthlyStats`, `meta`,
and `menu`:

1. Read `counters[monthKey]`, increment it, and write it back. This produces `INV-YYYYMM-NNNN`.
2. Draw the next cheesy line from the shuffle bag and advance the bag.
3. `add()` the bill. Because `add()` fails on a duplicate key, a duplicate bill number is impossible.
4. Update `monthlyStats[monthKey]` incrementally.
5. Mark the dishes used as `usedInBills`.

IndexedDB transactions are atomic: either every step commits or none does. Two tabs billing at
once are serialized by the browser, so a bill number can never repeat. The month resets
naturally, because a new `monthKey` starts at 0.

- **Bill numbers past 9999 in a month:** the number widens to `INV-202609-10000` rather than wrapping around.

### Void

`voidBill(billNo, reason)` runs as one transaction:
- It sets `status='void'`, `voidReason` (required, 3–200 chars), and `voidedAt`.
- It **subtracts** the bill's numbers from `monthlyStats` and increments `voidCount`.
- The bill stays in `bills` for the audit trail.

---

## 4. Money and discount math (`core/money.ts`, `core/totals.ts`)

1. `subtotal = Σ unitPaise × qty` (integers).
2. Discount:
   - Flat: `discountPaise = min(flat, subtotal)`.
   - Percent: `discountPaise = roundHalfUp(subtotal × bp / 10000)`, where `bp` is at most 10000.
3. `total = subtotal − discount (+ roundOff)`. Round-off goes to the nearest rupee, half-up, and can be toggled in Settings.
4. No tax is charged (local business).
5. `formatINR(paise)` is the **only** place paise become `₹1,23,456.78` (Indian digit grouping).
   It is used for display only.

`roundHalfUp` uses integer arithmetic only, so there is no `0.1 + 0.2` float drift.

---

## 5. Features, screen by screen

### 5.1 Billing (`#/billing`, the default screen)

**Menu grid**
- Shows active dishes, with category chips to filter them.
- Search is debounced (150 ms) and matches `nameLower.includes(q)` against an in-memory index.
  The index is built once and rebuilt only when the menu changes.

**Adding items**
- Tap a dish card to add 1.
- The cart line has `−` / `+` buttons and a numeric input. Quantity is clamped to an integer in 1–999.
  `−` at 1 asks you to remove the line.

**Order details**
- Order type segmented control: Dine-in shows a Table no. field. Takeaway and Delivery do not.
- Discount toggle: ₹ or %, with its own input.
- Payment: Cash / UPI / Card. Customer name is optional.

**Totals and saving**
- The running total updates live. Updates are batched through `requestAnimationFrame`.
- **Save & Print** saves the bill, then opens the receipt preview.
- **Save** saves the bill only.

**Keyboard shortcuts**

| Key | Action |
|---|---|
| `/` | Focus search |
| `↑` / `↓` | Move through results |
| `Enter` | Add the highlighted item (or the first result) |
| `Ctrl+P` | Save & print (intercepts the browser's own print) |
| `Esc` | Clear search |

**Other details**
- A cart draft is autosaved to `meta` so a reload doesn't lose the order in progress.
- Event delegation: one click listener on the grid and one on the cart.

### 5.2 Menu management (`#/menu`)

- The table/grid is filterable by search, category, and active/disabled.
- The add/edit form uses native inputs with validation:
  - name 1–60 chars
  - price between ₹0.01 and ₹1,00,000, entered in ₹ and parsed to paise with a strict regex
  - category, chosen from existing ones or typed as a new one
  - veg / non-veg
  - active toggle
- **Disable** hides a dish from billing.
- **Delete:**
  - If the dish was never billed, it is hard-deleted after a confirmation.
  - Otherwise it is soft-deleted (`deleted=true`). It stays in old bills and reports.
- The first run offers **"Load sample menu"** (about 20 dishes) so the app isn't empty. This is optional.

### 5.3 Receipt and print

The receipt is rendered with DOM APIs into `#print-root`.

**Receipt contents**
- Logo, name, address, phone, bill no, date/time, order type/table
- Items table
- Subtotal, discount, round-off, **Grand total**
- Payment mode
- The cheesy line

**Printing**
- The `@media print` CSS hides the app and shows only the receipt.
- `@page` sizes:
  - **58 mm**: 48 mm printable width, 11px mono-ish font
  - **80 mm**: 72 mm printable width
  - **A4**: centered, a larger layout with a proper table
- The format is taken from settings and can be overridden per print in the preview.
- `window.print()` opens the print dialog, which also offers "Save as PDF".
- Thermal paper uses `@page { size: 80mm auto; margin: 0 }`.

**WhatsApp**
- The button opens `https://wa.me/?text=<encoded summary>` in a new tab.
  The summary has the bill no, items, total, and the cheesy line.
- This is a user-initiated link, not a network call made by the app.

**Reprint**
- Any bill in Reports can be reprinted. Reprints use the stored `cheesyLine` and the item snapshots.

**Logo**
- The upload is checked by MIME type **and** magic bytes (the first bytes of the file, which
  identify its real type). Only PNG/JPG/WEBP up to 2 MB is accepted.
- It is drawn on a canvas at a maximum of 300 px on the longest side.
- It is exported as a WEBP data URL at quality 0.85, with a JPEG fallback, and stored in `settings`.

### 5.4 Cheesy lines

- 40 built-in lines ship in `data/cheesyLines.ts`.
- In Settings you can add, edit, disable, and delete your own lines. Built-in lines can be edited or disabled.
- **Shuffle bag:**
  - Fisher-Yates shuffle the active line ids, then hand them out in order.
  - When the bag is empty, reshuffle.
  - The first item of the new bag is never the same as the last line used.
  - The bag is persisted in `meta`, and adding or removing lines rebuilds it.
  - The draw happens inside the `saveBill` transaction.
- It uses `crypto.getRandomValues` for randomness.

### 5.5 Records and reports (`#/reports`, lazy-loaded)

**Filters**
- Date presets: Today / Yesterday / This week (Mon-start) / This month / Last month / Custom range.
- Month picker.
- Category, payment mode, order type, veg/non-veg.
- Amount min/max (₹).
- Bill-number search (exact or prefix).
- "Show voided" toggle.

**Query strategy (this is what keeps it fast with 50,000+ bills)**
- **Fast path:** a whole-month view with no extra filters reads only `monthlyStats`.
  That is 1 record, in O(1) time (instant, regardless of bill count).
- **Filtered path:**
  - It opens a cursor on the `createdAt` index, bounded by `IDBKeyRange` to the chosen dates.
  - It streams the bills one at a time and aggregates them in a single pass into hash maps
    (lookup tables keyed by dish/category).
  - It never builds a big array.
  - Other filters are applied per bill during the scan.
  - Rendering happens after the scan. A progress indicator shows if the scan takes more than 200 ms.
- **How the category filter works:** a bill matches if it contains an item from that
  category. Dish and category charts then count only the items from that category.

**KPIs**
- Revenue, bill count, average bill, items sold, discounts given.
- Voided bills are excluded, and the voided count is shown separately.

**Top 10 dishes**
- One list ranked by quantity and one ranked by revenue.
- Uses a hash-map count plus a **min-heap of size K**: O(n log K), no full sort.

**Least-sold dishes**
- A bottom-K with a max-heap.
- Active dishes with **zero** sales in the range are included, since those are the best candidates to remove.

**Charts** (hand-written SVG, with `role="img"` and accessible labels)
- Category-wise sales: horizontal bars.
- Payment-mode split: donut plus a legend table.
- Peak hours: 24-bar column chart.
- Best days of the week: 7 bars.
- Month over month: this month vs last month for each KPI, with a % change and ▲/▼ arrows.
  Data comes from `monthlyStats`. A daily line compares the two months.

**Bill list**
- Newest first, loaded 50 at a time with a cursor on `createdAt` in `prev` direction.
- A "Load more" button plus an IntersectionObserver.
- Each row: View / Reprint / Void (the reason is required, in a modal).

**CSV export**
- Exports the current filtered view: a bills sheet plus an optional line-items sheet as a second file.
- Starts with a UTF-8 BOM (a marker so Excel shows ₹ correctly).
- Values are quoted per RFC 4180.
- **Guards against CSV injection:** cells starting with `= + - @` are prefixed with `'`.
- Downloaded via a Blob and an object URL.

### 5.6 Settings and data safety (`#/settings`)

**Settings fields**
- Restaurant name, address, phone, logo.
- Currency symbol (≤ 3 chars, default ₹).
- Receipt width.
- Round-off toggle.
- Cheesy lines editor.

**Backup**
- Downloads `restobill-backup-YYYY-MM-DD.json` with every store and a `schemaVersion`.
- Sets `lastBackupAt`.

**Restore**
1. Parse the JSON.
2. Run **strict validation**:
   - unknown keys are rejected
   - every field's type and range is checked
   - money must be integer paise
   - bill numbers must match the format, with totals re-computed and cross-checked
   - maximum file size is 50 MB
3. Show a summary ("1,204 bills, 38 dishes — replace current data?").
4. Replace everything in one transaction.
5. The validator is hand-written, with no schema library.

**Storage safety**
- `navigator.storage.persist()` is called on first run and its status is shown in Settings.
  It asks the browser not to auto-delete the data.
- A gentle, dismissible banner appears if the last backup was more than 7 days ago, or never
  happened and there are more than 0 bills.

---

## 6. Security

- **No `innerHTML`** with any data. All UI is built with `document.createElement` and `textContent`.
  A grep check in the tests fails if `innerHTML` / `outerHTML` / `insertAdjacentHTML` appear in `src/`.
- **Input validation** is done by central validators in `core/validate.ts`:
  - price > 0
  - integer quantity 1–999
  - max lengths
  - trimming and removing control characters

**Security headers** are set in both `netlify.toml` and `vercel.json`.

The Content-Security-Policy (CSP):
```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self';
  img-src 'self' data: blob:; font-src 'self'; connect-src 'self';
  manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests
```

The other headers:
```
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

- With no `'unsafe-inline'`, the code never uses inline `<script>`, inline `<style>` blocks, or
  `setAttribute('style', …)`. Dynamic styling uses `el.style.x = …` or classes, which CSP allows.
- There are no external requests, no analytics, no web fonts, and no secrets.

---

## 7. Performance

- Event delegation on the grid, cart, and bill list.
- DOM writes are batched with `requestAnimationFrame`. The cart re-renders only the changed line and the totals.
- The search index is precomputed. The menu grid reuses card nodes instead of rebuilding them.
- Reports use indexed range queries and the `monthlyStats` fast path. There is no full scan unless you filter across all time.
- Reports are lazy-loaded. The CSS is small and there are no web fonts.
- `scripts/seed-bills.ts` generates **50,000 realistic bills** for load testing.
- I will measure:
  - save-bill latency
  - report load time
  - bill-list pagination

  The targets are < 50 ms, < 1 s filtered, and < 100 ms respectively.
- **Lighthouse targets:** ≥ 95 for Performance, Accessibility, and Best Practices.

---

## 8. PWA / offline

- `public/manifest.webmanifest` with name, icons (192 / 512 / maskable), `display: standalone`, and theme color.
- **Service worker** (`src/sw.ts`, about 1 KB):
  - It precaches the built assets. A tiny custom Vite plugin injects the hashed file list at
    build time, so no Workbox is needed.
  - It serves cache-first for assets and network-first-then-cache for `index.html`.
  - Old caches are deleted on activate.
  - When a new version is waiting, an "Update available — reload" toast appears.

---

## 9. File tree

```
/
├─ index.html
├─ PLAN.md  CLAUDE.md  README.md
├─ package.json  tsconfig.json  vite.config.ts  playwright.config.ts
├─ netlify.toml  vercel.json
├─ public/
│  ├─ manifest.webmanifest
│  └─ icons/ (icon-192.png, icon-512.png, maskable-512.png, favicon.svg)
├─ scripts/
│  ├─ check-size.mjs        # fails build if JS > 60 KB gz
│  └─ seed-bills.ts         # 50k-bill load test data
├─ src/
│  ├─ main.ts               # bootstrap, router, SW registration, persist()
│  ├─ router.ts
│  ├─ sw.ts
│  ├─ styles/  tokens.css  base.css  layout.css  components.css  print.css
│  ├─ core/    money.ts totals.ts billNo.ts shuffleBag.ts topK.ts dates.ts
│  │           csv.ts validate.ts image.ts debounce.ts
│  ├─ db/      db.ts (open + upgrade) types.ts menuRepo.ts billRepo.ts
│  │           statsRepo.ts settingsRepo.ts linesRepo.ts backup.ts
│  ├─ data/    cheesyLines.ts  sampleMenu.ts
│  └─ ui/
│     ├─ dom.ts             # h() helper — textContent only
│     ├─ components/  toast.ts modal.ts banner.ts nav.ts
│     ├─ billing/     billingView.ts menuGrid.ts cart.ts shortcuts.ts
│     ├─ menu/        menuView.ts dishForm.ts
│     ├─ receipt/     receipt.ts print.ts whatsapp.ts
│     ├─ settings/    settingsView.ts linesEditor.ts backupView.ts
│     └─ reports/     (lazy) reportsView.ts filters.ts query.ts kpis.ts
│                     charts.ts billList.ts exportCsv.ts
└─ tests/
   ├─ unit/  money, totals, billNo, stats(aggregation), topK, shuffleBag,
   │         validate(import), csv, noInnerHTML
   └─ e2e/   flow.spec.ts  screenshots.spec.ts
```

---

## 10. Phases (one git commit or more per phase)

| # | Phase | Output | Checks |
|---|---|---|---|
| 0 | **Scaffold** | `git init`, Vite + TS strict, folders, CLAUDE.md, header configs, app shell (nav + router + empty screens), size-check script | build passes, screenshots 375/1280 |
| 1 | **Core logic** | money, totals, discount, billNo, shuffle bag, top-K, validators, CSV | Vitest green |
| 2 | **Database** | schema, repos, `saveBill` / `voidBill` transactions, `monthlyStats` updates | Vitest + fake-indexeddb, including a concurrent-save no-duplicate test |
| 3 | **Menu management** | CRUD, soft delete, search, sample menu | screenshots + console clean |
| 4 | **Billing** | grid, cart, order type, discount, payment, shortcuts, draft autosave | screenshots + console clean |
| 5 | **Receipt & print** | 58/80/A4 print CSS, preview, WhatsApp, reprint, logo | print-emulation screenshots |
| 6 | **Settings & data safety** | details, logo upload, lines editor, backup/restore + validation, persist, reminder banner | Vitest (import validation) + screenshots |
| 7 | **Reports (lazy)** | filters, KPIs, SVG charts, top/least-sold, MoM, void, pagination, CSV | screenshots + aggregation tests |
| 8 | **PWA** | manifest, service worker, update toast | offline reload test in Playwright |
| 9 | **Performance & hardening** | 50k seed, timings, Lighthouse, bundle budget, a11y pass | Lighthouse ≥ 95 ×3, size ≤ 60 KB |
| 10 | **E2E & deploy** | Playwright full flow, README with 1-click deploy buttons | all tests green |

**Screenshots:** the Playwright MCP isn't connected in this environment. For UI checks I'll use
a Playwright script to open the dev server, capture 375px and 1280px screenshots, and collect
console errors. Then I'll review the images myself. It is the same check, with a different driver.

---

## 11. Decisions (all defaults accepted)

1. ~~GST~~ **Removed:** no tax or GST (local business).
2. **Round the grand total to the nearest rupee?** Default: **yes, with a "Round off"
   line, toggleable in Settings.**
3. **Offer a sample menu on first run?** Default: **yes, optional button.**
4. **Timezone:** default is the **device's local time**. "Today" means the device's today.
5. **Look and feel** without `/design`: **warm saffron accent** as described in §1. Drop
   screenshots into `/design` anytime and I'll match them.
