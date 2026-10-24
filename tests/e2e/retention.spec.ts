import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { unzip, cells } from '../helpers/unzip';

/**
 * 3-month limit in the real app, moving the browser clock (India time):
 * bills in June, July, August (×2) and September; on 30 September the app keeps
 * July–September and warns that July goes next (with its Excel); on 1 October
 * exactly July disappears.
 */
const IST = (iso: string) => new Date(`${iso}+05:30`);
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 640;

async function billAt(page: Page, iso: string) {
  await page.clock.setFixedTime(IST(iso));
  await page.getByRole('link', { name: 'Billing', exact: true }).click();
  await page.locator('.dish-card', { hasText: 'Full Chicken' }).first().click();
  if (isPhone(page)) await page.locator('.cart-bar').click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const title = await page.locator('dialog[open] .modal-title').innerText();
  await page.locator('dialog[open]').getByRole('button', { name: 'Done' }).click();
  return title.replace('Receipt ', '');
}

async function billsIn(page: Page, from: string, to: string): Promise<string[]> {
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await page.getByLabel('Date range').selectOption('custom');
  await page.getByLabel('From date').fill(from);
  await page.getByLabel('To date').fill(to);
  await page.getByLabel('To date').dispatchEvent('change');
  await expect(page.locator('.list-status')).not.toHaveText('Loading…');
  return page.locator('.bill-row .bill-no').allInnerTexts();
}

test('keeps 3 months: warns before, then deletes exactly the oldest month on the 1st', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.clock.setFixedTime(IST('2026-06-20T12:00:00'));
  await page.goto('/#/menu');
  await page.getByRole('button', { name: /Load Tikka Bites menu/ }).click();
  await expect(page.locator('.dish-row')).toHaveCount(40);

  expect(await billAt(page, '2026-06-20T13:00:00')).toBe('RCPT-2026-0001');
  expect(await billAt(page, '2026-07-20T13:00:00')).toBe('RCPT-2026-0002');
  expect(await billAt(page, '2026-08-10T13:00:00')).toBe('RCPT-2026-0003');
  expect(await billAt(page, '2026-08-11T13:00:00')).toBe('RCPT-2026-0004');
  expect(await billAt(page, '2026-09-20T13:00:00')).toBe('RCPT-2026-0005');

  // ---- 30 September, 23:50: June is past the limit; July goes tomorrow ----
  await page.clock.setFixedTime(IST('2026-09-30T23:50:00'));
  await page.reload();
  await expect(page.locator('.nav-link').first()).toBeVisible();
  const banner = page.locator('.banner', { hasText: 'will be deleted' });
  await expect(banner).toContainText('On 1 Oct, Jul 2026 bills will be deleted.');
  const [download] = await Promise.all([page.waitForEvent('download'), banner.getByRole('button', { name: 'Download Jul 2026 Excel' }).click()]);
  expect(download.suggestedFilename()).toBe('Tikka-Bites-sales_2026-07-01_to_2026-07-31.xlsx');
  const path = test.info().outputPath('july.xlsx');
  await download.saveAs(path);
  const bills = cells(unzip(new Uint8Array(readFileSync(path))).get('xl/worksheets/sheet2.xml')!);
  expect([bills['A2'], bills['A3']]).toEqual(['RCPT-2026-0002', undefined]); // July's one bill

  expect(await billsIn(page, '2026-06-01', '2026-06-30')).toEqual([]); // June already deleted
  expect(await billsIn(page, '2026-07-01', '2026-09-30')).toEqual(['RCPT-2026-0005', 'RCPT-2026-0004', 'RCPT-2026-0003', 'RCPT-2026-0002']);

  // ---- 1 October, 00:05: exactly July is deleted ----
  await page.clock.setFixedTime(IST('2026-10-01T00:05:00'));
  await page.reload();
  await expect(page.locator('.nav-link').first()).toBeVisible();
  expect(await billsIn(page, '2026-07-01', '2026-07-31')).toEqual([]);
  expect(await billsIn(page, '2026-08-01', '2026-09-30')).toEqual(['RCPT-2026-0005', 'RCPT-2026-0004', 'RCPT-2026-0003']);
  await expect(page.locator('.banner', { hasText: 'will be deleted' })).toHaveCount(0); // not the last week any more

  // New bills in October start at 0001; kept months are untouched.
  expect(await billAt(page, '2026-10-01T00:10:00')).toBe('RCPT-2026-0006'); // the year's count carries on after the clean-up
  expect(errors).toEqual([]);
});
