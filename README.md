# Tikka Bites — billing app

*Taste the flame.* A fast, installable billing app built for **Tikka Bites** (📞 9137582060). It runs entirely in the browser:
there's **no login, no server, no monthly fee**, and **your data never leaves the device**.

- **Billing:** tap dishes to add them. Supports Dine-in (with table no.), Takeaway or Delivery,
  flat ₹ or % discounts, Cash / UPI, and an optional customer name.
- **Bill numbers:** `INV-YYYYMM-0001`. They restart every month and can never repeat.
- **Receipts:**
  - 58 mm and 80 mm thermal paper, or A4. "Save as PDF" works from the print dialog.
  - The round Tikka Bites logo, name, address and phone at the top. You can upload a different logo or turn the logo off.
  - A cheesy one-liner at the bottom. 40 are built in, you can add your own, and none repeats until all have been used.
  - A **Share on WhatsApp** button.
- **Menu:** comes with the full **Tikka Bites menu**: 40 dishes in the menu card's 8 sections (Grill Gali, Lapete Mein, Burger Adda, Toast Ka Dosh, Murga Bole Kukdoo Koo, Aloo Ke Laloo, Mitthu Miya, Thanda Matter), each with a photo. You can add, edit and disable dishes and upload your own dish photos. A dish that appears in old bills is hidden when deleted, never erased.
- **Brand:** the round Tikka Bites logo prints on every receipt, and the wide logo sits in the app header. Light and dark themes use the logo's flame red, charcoal black and white. The theme follows your device, or you can pick one (the button in the nav, or *Settings → Appearance*).
- **Reports:**
  - Revenue, bill count, average bill, top and least-sold dishes, sales by category, payment split, peak hours, best weekdays, and a month-over-month comparison.
  - Filters: date presets, month picker, custom range, category, payment, order type, veg/non-veg, amount range, bill number.
  - **Export to Excel** (`.xlsx`) for any filtered period. You get one workbook with Summary, Bills, Items and Dish Sales sheets. Dates and times are real Excel dates, and amounts are in ₹.
  - Void a bill with a reason; it's kept on record but left out of totals.
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

## Deploy for free on GitHub Pages (about 5 minutes)

You only need a free [GitHub](https://github.com) account. The app will live at
`https://<your-username>.github.io/tikka-bites/`.

### 1. Create an empty repository on GitHub

On github.com, click **+ → New repository** and name it `tikka-bites`. Leave it **empty**:
don't add a README, .gitignore or licence. Then click **Create repository**.

### 2. Push the code (run these in the project folder)

```powershell
cd "G:\Billing system"
git remote add origin https://github.com/<your-username>/tikka-bites.git
git push -u origin main
```

The first push opens a GitHub sign-in window. Sign in, and the push continues.

### 3. Turn on GitHub Pages (one time)

In the repository, go to **Settings → Pages → Build and deployment → Source**, choose
**GitHub Actions**, and save.

Then open the **Actions** tab. The **Deploy to GitHub Pages** workflow runs the tests, builds
the app and publishes it, which takes about 1–2 minutes. If it ran before Pages was switched on
and failed, click it and choose **Re-run all jobs**.

Your app is now live at `https://<your-username>.github.io/tikka-bites/`.

### Updating the live app later

```powershell
git add -A
git commit -m "Describe what you changed"
git push
```

Each push re-tests and republishes the app automatically. Open devices show a
"New version ready — Reload" prompt, and never reload in the middle of a bill.

### Alternative: Netlify or Vercel

The same repository also deploys to Netlify or Vercel. Import it there; the settings are read
from `netlify.toml` / `vercel.json`. Those hosts also send extra security headers that GitHub Pages
can't (for example, blocking the app from being embedded in other sites).

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/<your-username>/tikka-bites)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/<your-username>/tikka-bites)

### Install it on the billing device

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
npm test             # unit tests (Vitest), incl. month/date boundaries in IST
npm run e2e          # end-to-end tests (Playwright) against the production build
npm run build        # type-check + build + fail if startup JS > 60 KB gzipped
npm run serve:dist   # serve dist/ with the exact production security headers
npm run serve:dist -- 4176 --pages /tikka-bites/   # imitate GitHub Pages (sub-folder, no headers)
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
