import { test, expect } from '@playwright/test';
import { appReady, callScript, declineFingerprint, resetSheets, sheets, signIn, signOut, watchErrors } from './helpers';

/**
 * Settings → Users with Google Sheets: the super admin (owner) adds a user, changes their
 * password and removes them, through the real google-sheets/Code.gs. Plain staff don't see
 * it, and the script refuses them even when asked directly. The owner sees the Backup status.
 */

test.beforeEach(resetSheets);

test('super admin adds, changes and removes users; staff cannot; backup status shown', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto('./');
  await signIn(page, 'owner', 'owner-pass-123');
  await declineFingerprint(page);
  await page.getByRole('button', { name: 'Set up from this phone' }).click();
  await appReady(page);

  // ---------- The super admin sees Settings → Users, with the Backup sheet's status ----------
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const users = page.locator('section', { has: page.getByRole('heading', { name: 'Users', exact: true }) });
  await expect(users.locator('.user-row')).toHaveText([/^owner\s*Super admin · you/, /^counter1\s*Staff/]);
  await expect(users.getByText('Backup Google Sheet: up to date.')).toBeVisible();

  // ---------- Add cashier3 ----------
  await users.getByLabel('User ID').fill('Cashier3');
  await users.getByLabel('Password', { exact: true }).fill('cashier-pass-1');
  await users.getByRole('button', { name: 'Add user' }).click();
  await expect(page.getByText('cashier3 can now sign in')).toBeVisible();
  await expect(users.locator('.user-row', { hasText: 'cashier3' })).toContainText('Staff');
  expect((await sheets()).main.users.find((u) => u.username === 'cashier3')).toEqual({ username: 'cashier3', role: 'staff', removed: false });
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    await users.screenshot({ path: test.info().outputPath(`users-sheets-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // The same User ID again: the sheet says no.
  await users.getByLabel('User ID').fill('cashier3');
  await users.getByLabel('Password', { exact: true }).fill('cashier-pass-1');
  await users.getByRole('button', { name: 'Add user' }).click();
  await expect(users.getByText('User ID cashier3 is already used')).toBeVisible();

  // ---------- Change cashier3's password ----------
  await users.locator('.user-row', { hasText: 'cashier3' }).getByRole('button', { name: 'Change password' }).click();
  const dlg = page.locator('dialog[open]');
  await dlg.getByLabel('New password', { exact: true }).fill('cashier-pass-2');
  await dlg.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByText('Password changed for cashier3')).toBeVisible();

  // ---------- cashier3 signs in on this phone, with the new password only ----------
  await signOut(page);
  await signIn(page, 'cashier3', 'cashier-pass-1');
  await expect(page.getByRole('alert')).toHaveText('Wrong User ID or password.');
  const asked = page.waitForRequest((r) => r.method() === 'POST' && (r.postData() ?? '').includes('"fn":"my_role"'));
  await signIn(page, 'cashier3', 'cashier-pass-2');
  await declineFingerprint(page);
  await appReady(page);
  const token = JSON.parse((await asked).postData() ?? '{}').token as string;
  await expect(page.getByText('Signed in as cashier3')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toHaveCount(0); // staff don't see it

  // Even asking the script directly, staff are refused and nothing changes.
  const r = await callScript('staff_admin', { action: 'remove', username: 'counter1' }, token);
  expect(r).toMatchObject({ ok: false, error: { kind: 'rejected', message: 'Only the super admin can manage users.' } });
  expect((await sheets()).main.users.find((u) => u.username === 'counter1')?.removed).toBe(false);

  // ---------- The super admin removes cashier3 ----------
  await signOut(page);
  await signIn(page, 'owner', 'owner-pass-123');
  await declineFingerprint(page);
  await appReady(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await users.locator('.user-row', { hasText: 'cashier3' }).getByRole('button', { name: 'Remove' }).click();
  await page.locator('dialog[open]').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('cashier3 was removed')).toBeVisible();
  await expect(users.locator('.user-row', { hasText: 'cashier3' })).toHaveCount(0);
  expect((await callScript('my_role', {}, token)).error?.kind).toBe('auth'); // their sign-in no longer works anywhere

  await signOut(page);
  await signIn(page, 'cashier3', 'cashier-pass-2');
  await expect(page.getByRole('alert')).toHaveText('Wrong User ID or password.');
  expect(errors).toEqual([]);
  await ctx.close();
});
