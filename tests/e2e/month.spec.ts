import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzip, cells } from '../helpers/unzip';

/**
 * Month boundary, end to end, on Indian time: a bill at 11:58 PM on 31 Jan and one at
 * 12:02 AM on 1 Feb must get January / February numbers, dates and report months,
 * and the Excel export must show the same local dates.
 */
const IST = (iso: string) => new Date(`${iso}+05:30`);
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 640;

async function billOneWrap(page: Page) {
  await page.getByRole('link', { name: 'Billing', exact: true }).click();
  await page.locator('.dish-card', { hasText: 'Chicken Tikka Wrap' }).first().click();
  if (isPhone(page)) await page.locator('.cart-bar').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog.locator('.modal-title')).toBeVisible();
  const title = await dialog.locator('.modal-title').innerText();
  const date = await dialog.locator('.r-meta .r-row', { hasText: 'Date' }).locator('.r-num').innerText();
  await dialog.getByRole('button', { name: 'Done' }).click();
  return { billNo: title.replace('Bill ', ''), date };
}

test('bills around midnight on the 1st land in the right month everywhere', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.clock.setFixedTime(IST('2026-01-31T23:58:00'));
  await page.goto('/#/menu');
  await page.getByRole('button', { name: /Load Tikka Bites menu/ }).click();
  await expect(page.locator('.dish-row')).toHaveCount(40);

  const jan = await billOneWrap(page);
  expect(jan).toEqual({ billNo: 'INV-202601-0001', date: '31/01/2026 23:58' });

  await page.clock.setFixedTime(IST('2026-02-01T00:02:00'));
  const feb = await billOneWrap(page);
  expect(feb).toEqual({ billNo: 'INV-202602-0001', date: '01/02/2026 00:02' });

  // Reports: "This month" (February) and "Last month" (January) each hold one bill.
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  const bills = page.locator('.kpi', { hasText: 'Bills' }).locator('.kpi-value');
  await expect(page.locator('.range-label')).toHaveText('This month · Feb 2026');
  await expect(bills).toHaveText('1');
  await expect(page.locator('.bill-row')).toHaveCount(1);
  await expect(page.locator('.bill-row .bill-when')).toHaveText('01/02/2026 00:02');

  await page.getByLabel('Date range').selectOption('lastMonth');
  await expect(page.locator('.range-label')).toHaveText('Last month · Jan 2026');
  await expect(bills).toHaveText('1');
  await expect(page.locator('.bill-row .bill-no')).toHaveText('INV-202601-0001');

  await page.getByLabel('Date range').selectOption('today');
  await expect(page.locator('.bill-row .bill-no')).toHaveText('INV-202602-0001');
  await page.getByLabel('Date range').selectOption('yesterday');
  await expect(page.locator('.bill-row .bill-no')).toHaveText('INV-202601-0001');

  // Month over month compares Feb with Jan.
  await page.getByLabel('Date range').selectOption('month');
  await expect(page.locator('.report-card', { hasText: 'Month over month' }).locator('.card-title')).toHaveText('Month over month · Feb 2026 vs Jan 2026');

  // Excel export over both days: real .xlsx, local dates preserved.
  await page.getByLabel('Date range').selectOption('custom');
  await page.getByLabel('From date').fill('2026-01-31');
  await page.getByLabel('To date').fill('2026-02-01');
  await page.getByLabel('To date').dispatchEvent('change');
  await expect(page.locator('.bill-row')).toHaveCount(2);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export to Excel' }).click()]);
  expect(download.suggestedFilename()).toBe('Tikka-Bites-sales_2026-01-31_to_2026-02-01.xlsx');
  await expect(page.getByRole('button', { name: /CSV/ })).toHaveCount(0); // Excel is the only export

  const path = test.info().outputPath('export.xlsx');
  await download.saveAs(path);
  const files = unzip(new Uint8Array(readFileSync(path)));
  const wb = files.get('xl/workbook.xml')!;
  expect([...wb.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])).toEqual(['Summary', 'Bills', 'Items', 'Dish Sales']);
  const b = cells(files.get('xl/worksheets/sheet2.xml')!); // Bills: header on row 1
  expect([b['A2'], b['B2'], b['A3'], b['B3']]).toEqual(['INV-202601-0001', 46053, 'INV-202602-0001', 46054]);
  expect(b['C2']).toBeCloseTo((23 * 60 + 58) / 1440, 8);
  expect(b['C3']).toBeCloseTo(2 / 1440, 8);
  expect(b['H2']).toBe('Cash');
  expect(b['N2']).toBe(150);

  expect(errors).toEqual([]);
});
