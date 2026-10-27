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
  return { billNo: title.replace('Receipt ', ''), date };
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
  expect(jan).toEqual({ billNo: 'RCPT-2026-0001', date: '31/01/2026 11:58 PM' });

  await page.clock.setFixedTime(IST('2026-02-01T00:02:00'));
  const feb = await billOneWrap(page);
  expect(feb).toEqual({ billNo: 'RCPT-2026-0002', date: '01/02/2026 12:02 AM' }); // numbers count through the year

  // Reports: "This month" (February) and "Last month" (January) each hold one bill.
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  const bills = page.locator('.kpi', { hasText: 'Bills' }).locator('.kpi-value');
  await expect(page.locator('.range-label')).toHaveText('This month · Feb 2026');
  await expect(bills).toHaveText('1');
  await expect(page.locator('.bill-row')).toHaveCount(1);
  await expect(page.locator('.bill-row .bill-when')).toHaveText('01/02/2026 12:02 AM');

  await page.getByLabel('Date range').selectOption('lastMonth');
  await expect(page.locator('.range-label')).toHaveText('Last month · Jan 2026');
  await expect(bills).toHaveText('1');
  await expect(page.locator('.bill-row .bill-no')).toHaveText('RCPT-2026-0001');

  await page.getByLabel('Date range').selectOption('today');
  await expect(page.locator('.bill-row .bill-no')).toHaveText('RCPT-2026-0002');
  await page.getByLabel('Date range').selectOption('yesterday');
  await expect(page.locator('.bill-row .bill-no')).toHaveText('RCPT-2026-0001');

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
  expect([b['A2'], b['B2'], b['A3'], b['B3']]).toEqual(['RCPT-2026-0001', 46053, 'RCPT-2026-0002', 46054]);
  expect(b['C2']).toBeCloseTo((23 * 60 + 58) / 1440, 8);
  expect(b['C3']).toBeCloseTo(2 / 1440, 8);
  expect(b['H2']).toBe('Cash');
  expect(b['N2']).toBe(150);

  expect(errors).toEqual([]);
});

test('a bill forgotten earlier this month is entered with its date from the calendar', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.clock.setFixedTime(IST('2026-10-24T15:00:00'));
  await page.goto('/#/menu');
  await page.getByRole('button', { name: /Load Tikka Bites menu/ }).click();
  await expect(page.locator('.dish-row')).toHaveCount(40);
  await page.getByRole('link', { name: 'Billing', exact: true }).click();
  await page.locator('.dish-card', { hasText: 'Chicken Tikka Wrap' }).first().click();
  if (isPhone(page)) await page.locator('.cart-bar').click();

  // The phone's own calendar, limited to 1 Oct … today; today means a normal bill.
  const date = page.getByLabel('Bill date');
  await expect(date).toHaveValue('2026-10-24');
  await expect(date).toHaveAttribute('min', '2026-10-01');
  await expect(date).toHaveAttribute('max', '2026-10-24');
  await expect(page.getByLabel('Bill time')).toBeHidden();
  await date.fill('2026-10-20');
  // The time on a 12-hour clock with AM/PM, whatever the phone's own setting (owner request, 27 Oct 2026).
  await page.getByLabel('Hour').selectOption('2');
  await page.getByLabel('Minute').selectOption('30');
  await page.getByLabel('AM or PM').selectOption('PM');
  await expect(page.locator('.bill-date-note')).toHaveText(/Tue 20 Oct 2026, 02:30 PM/);

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog.locator('.modal-title')).toHaveText('Receipt RCPT-2026-0001');
  await expect(dialog.locator('.r-meta .r-row', { hasText: 'Date' }).locator('.r-num')).toHaveText('20/10/2026 02:30 PM');
  await expect(dialog.locator('.r-meta .r-row', { hasText: 'Entered' }).locator('.r-num')).toHaveText('24/10/2026 03:00 PM');
  await dialog.getByRole('button', { name: 'Done' }).click();

  // It stays on that day for the next forgotten bill, until Today is tapped. An earlier one that day
  // takes number 0001 (numbers follow the date), and the 2:30 PM bill moves up to 0002.
  await page.locator('.dish-card', { hasText: 'Chicken Tikka Wrap' }).first().click();
  if (isPhone(page)) await page.locator('.cart-bar').click();
  await expect(date).toHaveValue('2026-10-20');
  await page.getByLabel('Hour').selectOption('1');
  await page.getByLabel('Minute').selectOption('15');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.locator('.modal-title')).toHaveText('Receipt RCPT-2026-0001');
  await expect(dialog.locator('.r-meta .r-row', { hasText: 'Date' }).locator('.r-num')).toHaveText('20/10/2026 01:15 PM');
  await dialog.getByRole('button', { name: 'Done' }).click();
  if (isPhone(page)) await page.locator('.dish-card', { hasText: 'Chicken Tikka Wrap' }).first().click();
  if (isPhone(page)) await page.locator('.cart-bar').click();
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(date).toHaveValue('2026-10-24');
  await expect(page.locator('.bill-date-note')).toBeHidden();
  if (isPhone(page)) await page.getByRole('button', { name: 'Back to menu' }).click();

  // Reports file it under 20 Oct.
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(page.locator('.bill-row .bill-when')).toHaveText(['20/10/2026 02:30 PM', '20/10/2026 01:15 PM']);
  await expect(page.locator('.bill-row .bill-no')).toHaveText(['RCPT-2026-0002', 'RCPT-2026-0001']);
  await expect(page.locator('.bill-row').first().locator('.bill-old-no')).toHaveText('was RCPT-2026-0001'); // the number on its paper receipt
  // Viewing it again shows both numbers.
  await page.locator('.bill-row').first().getByRole('button', { name: /View/ }).click();
  await expect(dialog.locator('.r-meta .r-row', { hasText: 'Old no.' }).locator('.r-num')).toHaveText('RCPT-2026-0001');
  await dialog.getByRole('button', { name: /Done|Close/ }).first().click();
  await page.getByLabel('Date range').selectOption('today');
  await expect(page.locator('.bill-row')).toHaveCount(0);
  expect(errors).toEqual([]);
});
