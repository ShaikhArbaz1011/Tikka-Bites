import { test, expect, type Page } from '@playwright/test';

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
  await expect(dialog.locator('.modal-title')).toHaveText(/INV-\d{6}-0001/);
  const billNo = (await dialog.locator('.modal-title').innerText()).replace('Bill ', '');
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
  const wa = await dialog.locator('a.btn-wa').getAttribute('href');
  expect(decodeURIComponent(wa!)).toContain(billNo);
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
  await expect(page.locator('dialog[open] .modal-title')).toHaveText(/INV-\d{6}-0001/);
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
