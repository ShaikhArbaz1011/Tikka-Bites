import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/** What the page handed to the share menu (recorded by a stub in beforeEach). */
type Shared = { __shared: { name: string; type: string; text: string }[] };

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 640;

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  // Record print calls instead of opening the real dialog.
  await page.addInitScript(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => {
      (window as unknown as { __prints: number }).__prints++;
    };
  });
  // Record what would go to the phone's share menu (WhatsApp) instead of opening it.
  await page.addInitScript(() => {
    const w = window as unknown as Shared;
    w.__shared = [];
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d?: ShareData) => !!d?.files?.length });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (d?: ShareData) => {
        for (const f of d?.files ?? []) {
          let text = '';
          for (const b of new Uint8Array(await f.arrayBuffer())) text += String.fromCharCode(b);
          w.__shared.push({ name: f.name, type: f.type, text });
        }
      },
    });
  });
  test.info().annotations.push({ type: 'console-errors', description: '' });
  (page as unknown as { __errors: string[] }).__errors = errors;
});

test.afterEach(async ({ page }) => {
  // Any console error (incl. CSP violations) fails the test.
  expect((page as unknown as { __errors: string[] }).__errors).toEqual([]);
});

async function addDish(page: Page, name: string, category: string, price: string, nonVeg = false) {
  await page.getByRole('button', { name: /Add (dish|your first dish)/ }).first().click();
  await page.getByLabel('Dish name').fill(name);
  await page.getByLabel('Category', { exact: true }).fill(category);
  await page.getByLabel('Price (₹)').fill(price);
  if (nonVeg) await page.locator('dialog label.seg-label', { hasText: 'Non-veg' }).click();
  await page.locator('dialog').getByRole('button', { name: 'Add dish' }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
}

test('add dishes → bill → print preview → appears in reports → void', async ({ page }) => {
  // 1. Menu
  await page.goto('/#/menu');
  await addDish(page, 'Masala Dosa', 'South Indian', '120');
  await addDish(page, 'Chicken Chettinad', 'Mains', '310.50', true);
  await expect(page.locator('.dish-row')).toHaveCount(2);

  // 2. Billing
  await page.getByRole('link', { name: 'Billing' }).click();
  await page.locator('.dish-card', { hasText: 'Masala Dosa' }).click();
  await page.locator('.dish-card', { hasText: 'Masala Dosa' }).click();
  // keyboard: "/" → search → Enter adds
  await page.keyboard.press('/');
  await page.keyboard.type('chettinad');
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  if (isPhone(page)) {
    await expect(page.locator('.cart-bar')).toContainText('3 items');
    await page.locator('.cart-bar').click();
  }
  await page.getByLabel('Table number').fill('9');
  await page.locator('label.seg-label', { hasText: '%' }).click();
  await page.getByLabel('Discount').fill('10');
  await page.locator('label.seg-label', { hasText: 'UPI' }).click();
  await expect(page.locator('label.seg-label', { hasText: 'Card' })).toHaveCount(0); // Card removed
  // 240 + 310.50 = 550.50; −10% = 55.05 → 495.45 → rounds to 495.00
  await expect(page.locator('.trow-total')).toContainText('₹495.00');

  // 3. Save & Print → receipt preview, print dialog requested
  await page.getByRole('button', { name: 'Save & Print' }).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog.locator('.modal-title')).toHaveText(/RCPT-\d{6}-0001/);
  const billNo = (await dialog.locator('.modal-title').innerText()).replace('Receipt ', '');
  await expect(dialog.locator('.receipt')).toContainText('Masala Dosa');
  await expect(dialog.locator('.receipt')).toContainText('Dine-in · Table 9');
  await expect(dialog.locator('.r-grand')).toContainText('₹495.00');
  await expect(dialog.locator('.receipt')).toContainText('UPI');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(1);
  const cheesy = await dialog.locator('.r-cheesy').innerText();
  expect(cheesy.length).toBeGreaterThan(5);

  // Print media shows only the receipt, in the chosen paper format.
  await dialog.locator('label.seg-label', { hasText: '58 mm' }).click();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#print-root .receipt.w58')).toBeVisible();
  await expect(page.locator('#app')).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  // Share PDF hands a phone-size PDF to the share menu (where WhatsApp is picked).
  await dialog.getByRole('button', { name: 'Share PDF' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Shared).__shared.length)).toBe(1);
  const pdf = await page.evaluate(() => (window as unknown as Shared).__shared[0]!);
  expect(pdf).toMatchObject({ name: `TikkaBites-${billNo}.pdf`, type: 'application/pdf' });
  expect(pdf.text.startsWith('%PDF-1.4')).toBe(true);
  expect(pdf.text).toContain('/MediaBox [0 0 360 780]');
  expect(pdf.text).toContain('/Count 1');
  expect(pdf.text.endsWith('%%EOF\n')).toBe(true);
  await dialog.getByRole('button', { name: 'Done' }).click();

  // 4. Reports
  await page.getByRole('link', { name: 'Reports' }).click();
  const kpi = (label: string) => page.locator('.kpi', { hasText: label }).locator('.kpi-value');
  await expect(kpi('Revenue')).toHaveText('₹495.00');
  await expect(kpi('Bills')).toHaveText('1');
  await expect(kpi('Items sold')).toHaveText('3');
  await expect(page.locator('.report-card', { hasText: 'by quantity' }).locator('.rank-name').first()).toHaveText('Masala Dosa');
  const row = page.locator('.bill-row', { hasText: billNo });
  await expect(row).toBeVisible();

  // Reprint shows the SAME cheesy line.
  await row.getByRole('button', { name: /View/ }).click();
  await expect(page.locator('dialog[open] .r-cheesy')).toHaveText(cheesy);
  await page.locator('dialog[open]').getByRole('button', { name: 'Done' }).click();

  // 5. Void → excluded from totals, kept in history.
  await row.getByRole('button', { name: /Void/ }).click();
  await page.locator('#void-reason').fill('Entered by mistake');
  await page.getByRole('button', { name: 'Void bill' }).click();
  await expect(kpi('Bills')).toHaveText('0');
  await expect(kpi('Revenue')).toHaveText('₹0.00');
  await page.locator('.more-summary').click();
  await page.getByLabel('Include voided bills in list').check();
  await expect(page.locator('.bill-row', { hasText: billNo }).locator('.badge-void')).toBeVisible();
});

test('works offline after the first visit (PWA)', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await page.goto('/#/menu');
  await page.getByRole('button', { name: /Load Tikka Bites menu/ }).click();
  await expect(page.locator('.dish-row')).toHaveCount(40);

  await context.setOffline(true);
  await page.reload();
  await page.getByRole('link', { name: 'Billing' }).click();
  await page.locator('.dish-card').first().click();
  if (isPhone(page)) await page.locator('.cart-bar').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('dialog[open] .modal-title')).toHaveText(/RCPT-\d{6}-0001/);
  await page.locator('dialog[open]').getByRole('button', { name: 'Done' }).click();
  await page.getByRole('link', { name: 'Reports' }).click();
  await expect(page.locator('.kpi', { hasText: 'Bills' }).locator('.kpi-value')).toHaveText('1');
});

test('rejects unsafe input and tampered backups', async ({ page }) => {
  await page.goto('/#/menu');
  await addDish(page, '<img src=x onerror=alert(1)>', 'Test', '10');
  await expect(page.locator('.dish-name')).toHaveText('<img src=x onerror=alert(1)>'); // shown as text
  await expect(page.locator('.dish-row img')).toHaveCount(0);

  await page.goto('/#/settings');
  await page.locator('#restore-file').setInputFiles({ name: 'evil.json', mimeType: 'application/json', buffer: Buffer.from('{"app":"restobill","schemaVersion":1,"hack":true}') });
  await expect(page.locator('.toast-error')).toContainText('Backup rejected');
});

test('the − button takes a dish from 3 to 2, and the saved bill says 2', async ({ page }) => {
  await page.goto('/#/menu');
  await page.getByRole('button', { name: /Load Tikka Bites menu/ }).click();
  await expect(page.locator('.dish-row')).toHaveCount(40);
  await page.getByRole('link', { name: 'Billing' }).click();
  const card = page.locator('.dish-card', { hasText: 'Chicken Tikka (5 Pcs)' });
  for (let i = 0; i < 3; i++) await card.click();
  await expect(card.locator('.qty-badge')).toHaveText('3');
  if (isPhone(page)) await page.locator('.cart-bar').click();
  const line = page.locator('.cart-line', { hasText: 'Chicken Tikka (5 Pcs)' });
  await expect(line.locator('.qty-input')).toHaveValue('3');
  await expect(page.locator('.trow-total')).toContainText('₹300.00');
  await line.getByRole('button', { name: 'One less Chicken Tikka (5 Pcs)' }).click();
  await expect(line.locator('.qty-input')).toHaveValue('2');
  await expect(page.locator('.trow-total')).toContainText('₹200.00');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const row = page.locator('dialog[open] .r-items tbody tr', { hasText: 'Chicken Tikka (5 Pcs)' });
  await expect(row.locator('.r-qty')).toHaveText('2');
  await expect(row.locator('.r-amt')).toHaveText('₹200.00');
});

test('after Save → Share PDF → Done no dish still looks selected (Clear too); the tagline prints below the logo', async ({ page }) => {
  // Tagline in Settings, next to the phone number.
  await page.goto('/#/settings');
  await page.getByLabel('Tagline').fill('Taste the Flame');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.locator('.toast', { hasText: 'Details saved' })).toBeVisible();

  await page.goto('/#/menu');
  await page.getByRole('button', { name: /Load Tikka Bites menu/ }).click();
  await expect(page.locator('.dish-row')).toHaveCount(40);
  await page.getByRole('link', { name: 'Billing' }).click();
  const tikka = page.locator('.dish-card', { hasText: 'Chicken Tikka (5 Pcs)' });
  await tikka.click();
  await tikka.click();
  await page.locator('.dish-card', { hasText: 'Full Chicken' }).first().click();
  const selected = page.locator('.dish-card.in-cart');
  const badges = page.locator('.dish-card .qty-badge:not([hidden])');
  await expect(selected).toHaveCount(2);
  if (isPhone(page)) await page.locator('.cart-bar').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  const dialog = page.locator('dialog[open]');
  await expect(dialog.locator('.r-tagline')).toHaveText('Taste the Flame');
  const head = await dialog.locator('.r-head').evaluate((el) => [...el.children].slice(0, 3).map((c) => c.className));
  expect(head).toEqual(['r-logo', 'r-tagline', 'r-name']); // just below the logo
  await dialog.getByRole('button', { name: 'Share PDF' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Shared).__shared.length)).toBe(1);
  await dialog.getByRole('button', { name: 'Done' }).click();

  // The bill was saved and cleared: no card keeps its highlight or count.
  await expect(selected).toHaveCount(0);
  await expect(badges).toHaveCount(0);
  await expect(page.locator('.cart-line')).toHaveCount(0);

  // Clear does the same.
  await tikka.click();
  await expect(selected).toHaveCount(1);
  if (isPhone(page)) await page.locator('.cart-bar').click();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(selected).toHaveCount(0);
  await expect(badges).toHaveCount(0);

  // Emptying the tagline removes it from receipts.
  await page.goto('/#/settings');
  await page.getByLabel('Tagline').fill('');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.locator('.toast', { hasText: 'Details saved' }).last()).toBeVisible();
  await page.goto('/#/billing');
  await tikka.click();
  if (isPhone(page)) await page.locator('.cart-bar').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.locator('.r-name')).toBeVisible();
  await expect(dialog.locator('.r-tagline')).toHaveCount(0);
});

test('Share PDF downloads the receipt where there is no share menu; long bills get more pages', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined }));
  await page.goto('/#/menu');
  await page.getByRole('button', { name: /Load Tikka Bites menu/ }).click();
  await expect(page.locator('.dish-row')).toHaveCount(40);
  await page.getByRole('link', { name: 'Billing' }).click();
  const cards = page.locator('.dish-card');
  await expect(cards).toHaveCount(40);
  for (let i = 0; i < 40; i++) await cards.nth(i).dispatchEvent('click');
  if (isPhone(page)) await page.locator('.cart-bar').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog.locator('.modal-title')).toHaveText(/RCPT-\d{6}-0001/);
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Share PDF' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^TikkaBites-RCPT-\d{6}-0001\.pdf$/);
  const pdf = readFileSync(await download.path(), 'latin1');
  expect(pdf.startsWith('%PDF-1.4')).toBe(true);
  const pages = Number(/\/Count (\d+)/.exec(pdf)![1]);
  expect(pages).toBeGreaterThan(1); // 40 dishes don't fit on one phone screen
  expect(pdf.match(/\/MediaBox \[0 0 360 780\]/g)).toHaveLength(pages); // every page is phone-sized
  await expect(dialog.getByRole('status')).toContainText('Attach it in WhatsApp');
});
