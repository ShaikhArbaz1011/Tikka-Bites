import { test, expect } from '@playwright/test';
import { KEY, SUPABASE, appReady, declineFingerprint, psql, signIn, signOut, watchErrors } from './helpers';

/**
 * Settings → Users: the super admin (owner) adds a user, changes their password and
 * removes them, through the real staff-admin server function and the real SQL.
 * Plain staff don't see it, and the server refuses them even when asked directly.
 */

test.beforeEach(async ({ request }) => {
  const r = await request.post(`${SUPABASE}/__test/reset`, { headers: { apikey: KEY } });
  expect(r.ok()).toBe(true);
});

test('super admin adds, changes and removes users; staff cannot', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto('./');
  await signIn(page, 'owner', 'owner-pass-123');
  await declineFingerprint(page);
  await page.getByRole('button', { name: 'Set up from this phone' }).click();
  await appReady(page);

  // ---------- The super admin sees Settings → Users ----------
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const users = page.locator('section', { has: page.getByRole('heading', { name: 'Users', exact: true }) });
  await expect(users.locator('.user-row')).toHaveText([/^owner\s*Super admin · you/, /^counter1\s*Staff/]);
  await expect(users.locator('.user-row', { hasText: 'owner' }).getByRole('button', { name: 'Remove' })).toHaveCount(0); // not yourself

  // Checked on the phone before anything is sent.
  await users.getByLabel('User ID').fill('Bad Name');
  await users.getByLabel('Password', { exact: true }).fill('short');
  await users.getByRole('button', { name: 'Add user' }).click();
  await expect(users.getByText('User ID must be 2–30 characters')).toBeVisible();
  await expect(users.getByText('Password must be at least 8 characters')).toBeVisible();

  // ---------- Add cashier3 ----------
  await users.getByLabel('User ID').fill('Cashier3');
  await users.getByLabel('Password', { exact: true }).fill('cashier-pass-1');
  await users.getByRole('button', { name: 'Add user' }).click();
  await expect(page.getByText('cashier3 can now sign in')).toBeVisible();
  await expect(users.locator('.user-row', { hasText: 'cashier3' })).toContainText('Staff');
  await expect(users.getByLabel('User ID')).toHaveValue(''); // form cleared
  expect(psql("select email || ' ' || role from public.staff where username = 'cashier3'")).toBe('owner+cashier3@tikka.test staff');
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    await users.screenshot({ path: test.info().outputPath(`users-${width}.png`) });
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // The same User ID again: the database says no.
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
  // After a new sign-in the screen behind is drawn again for that person (it was the owner's Settings).
  const asked = page.waitForResponse((r) => r.url().endsWith('/rpc/my_role'));
  await signIn(page, 'cashier3', 'cashier-pass-2');
  await declineFingerprint(page);
  await appReady(page);
  const myRole = await asked;
  await expect(page.getByText('Signed in as cashier3')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toHaveCount(0); // staff don't see it
  await expect(page.getByText('owner', { exact: true })).toHaveCount(0); // nor the owner's list

  // Even asking the server function directly, staff are refused and nothing changes.
  const r = await page.request.post(`${SUPABASE}/functions/v1/staff-admin`, {
    headers: { apikey: KEY, authorization: myRole.request().headers()['authorization'] ?? '' },
    data: { action: 'remove', username: 'counter1' },
  });
  expect(r.status()).toBe(400);
  expect((await r.json()).message).toBe('Only the super admin can manage users.');
  expect(psql("select count(*) from public.staff where username = 'counter1'")).toBe('1');

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
  expect(psql("select count(*) from auth.users where email = 'owner+cashier3@tikka.test'")).toBe('0'); // account deleted too

  await signOut(page);
  await signIn(page, 'cashier3', 'cashier-pass-2');
  await expect(page.getByRole('alert')).toHaveText('Wrong User ID or password.');
  expect(errors).toEqual([]);
  await ctx.close();
});
