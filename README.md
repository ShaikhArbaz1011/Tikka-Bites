# RestoBill — offline restaurant billing

A fast, installable billing app for a small restaurant. It runs entirely in the browser:
there's **no login, no server, no monthly fee**, and **your data never leaves the device**.

- **Billing:** tap dishes to add them. Supports Dine-in (with table no.), Takeaway or Delivery,
  flat ₹ or % discounts, Cash / UPI / Card, and an optional customer name.
- **Bill numbers:** `INV-YYYYMM-0001`. They restart every month and can never repeat.
- **Receipts:**
  - 58 mm and 80 mm thermal paper, or A4. "Save as PDF" works from the print dialog.
  - Your logo, name, address and phone at the top.
  - A cheesy one-liner at the bottom. 40 are built in, you can add your own, and none repeats until all have been used.
  - A **Share on WhatsApp** button.
- **Menu:** add, edit and disable dishes, with veg/non-veg marks. A dish that appears in old bills is hidden when deleted, never erased.
- **Reports:**
  - Revenue, bill count, average bill, top and least-sold dishes, sales by category, payment split, peak hours, best weekdays, and a month-over-month comparison.
  - Filters: date presets, month picker, custom range, category, payment, order type, veg/non-veg, amount range, bill number.
  - CSV export (opens in Excel). Void a bill with a reason; it's kept on record but left out of totals.
- **Data safety:** one-click JSON backup, and a restore that strictly checks the file. You get a reminder if your last backup is over 7 days old.
- **Works offline** and installs like an app on phones, tablets and PCs (it's a PWA).
- **No tax / GST lines.** It's built for a local business: total = subtotal − discount, rounded to the nearest rupee (you can turn rounding off).

Keyboard shortcuts on the Billing screen:

| Key | Action |
|---|---|
| `/` | Jump to search |
| `↑` / `↓` | Move through results |
| `Enter` | Add the highlighted dish |
| `Esc` | Clear search |
| `Ctrl + P` | Save & Print |

---

## Deploy for free (about 5 minutes)

You need a free [GitHub](https://github.com) account, plus a free Netlify **or** Vercel account.

### 1. Put the code on GitHub

```bash
# on GitHub, create an empty repository called "restobill" first, then:
git remote add origin https://github.com/<your-username>/restobill.git
git push -u origin main
```

### 2. One-click deploy

Replace `<your-username>` in these links with your GitHub username (or edit this README
after pushing, and the buttons will work for you):

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/<your-username>/restobill)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/<your-username>/restobill)

**Netlify manually:**
1. Go to *Add new site → Import an existing project → GitHub* and pick `restobill`.
2. The build settings are read from `netlify.toml`, so just click **Deploy**.

**Vercel manually:**
1. Go to *Add New… → Project* and import `restobill`.
2. The settings are read from `vercel.json`, so just click **Deploy**.

Both config files set up:
- the SPA fallback (every path serves `index.html`)
- long caching for built files
- strict security headers: Content-Security-Policy, X-Content-Type-Options, Referrer-Policy, X-Frame-Options and Permissions-Policy

Every later `git push` redeploys automatically. Open devices then show a
"New version ready — Reload" prompt, and never reload in the middle of a bill.

### 3. Install it on the billing device

Open your site's URL, then:
- **Android / Chrome:** tap ⋮ → *Install app*.
- **iPhone / Safari:** tap Share → *Add to Home Screen*.
- **Windows / Mac, Chrome or Edge:** click the install icon in the address bar.

---

## Printing tips

- **Thermal printers (58/80 mm):** in the print dialog, choose your printer, set **Margins: None**,
  and turn off **Headers and footers**. Pick the matching paper width under *Settings → Receipt paper*.
  You can also switch width per print in the receipt preview.
- **PDF:** choose **Save as PDF** as the printer.

## Your data

Everything lives in this browser's built-in database (IndexedDB), on this device only.
- Clearing the browser's site data, or using a different browser or device, means starting empty.
- Use **Settings → Download backup** regularly (the app reminds you weekly) and keep the file
  somewhere safe, e.g. email it to yourself.
- **Restore** replaces everything with the backup. The file is checked strictly first, so a damaged
  or edited file is rejected rather than half-loaded.

---

## For developers

```bash
npm install
npm run dev          # dev server at http://localhost:5173
npm test             # unit tests (Vitest)
npm run e2e          # end-to-end tests (Playwright) against the production build
npm run build        # type-check + build + fail if startup JS > 60 KB gzipped
npm run serve:dist   # serve dist/ with the exact production security headers
npm run seed:50k     # make seed-50k.json (50,000 bills) to restore for load testing
```

- **Stack:** Vite + vanilla TypeScript (strict). The only runtime dependency is `idb`, a
  tiny wrapper around IndexedDB. Charts are hand-written SVG and the service worker is hand-written too.
- **Money:** always stored as integer **paise** (₹1 = 100 paise), and turned into ₹ text only for display.
- **Architecture, data model and decisions:** see [`PLAN.md`](PLAN.md). Project rules are in [`CLAUDE.md`](CLAUDE.md).

**Measured results (production build):**
- **Startup JS:** about 18 KB gzipped. Reports load separately (about 9 KB) when first opened.
- **Lighthouse:** 99–100 for Performance, Accessibility and Best Practices, on mobile and desktop.
- **With 50,000 bills:**

  | Action | Time |
  |---|---|
  | Save a bill | about 75 ms |
  | This month's report | about 70 ms |
  | 18-month report | about 35 ms |
  | Filtered full scan | about 0.65 s |
  | Restore | about 2.5 s |
