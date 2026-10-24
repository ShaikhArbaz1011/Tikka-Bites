import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { appReady, psql, signIn, watchErrors } from './helpers';

/**
 * Shared database, end to end: two "phones" (browser contexts) use the real app
 * against scripts/fake-supabase.mjs, which runs supabase/schema.sql in PostgreSQL.
 */

async function addFingerprintSensor(ctx: BrowserContext, page: Page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

const pill = (page: Page) => page.locator('.nav .sync-pill');

async function billOne(page: Page, dish: string) {
  await page.getByRole('link', { name: 'Billing', exact: true }).click();
  await page.locator('.dish-card', { hasText: dish }).first().click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const title = page.locator('dialog[open] .modal-title');
  await expect(title).toBeVisible();
  const text = await title.innerText();
  return { no: text.replace('Receipt ', ''), dialog: page.locator('dialog[open]') };
}

test.beforeEach(async ({ request }) => {
  // Every run starts from an empty shared database (scripts/fake-supabase.mjs, test only).
  const r = await request.post('http://localhost:54321/__test/reset', { headers: { apikey: 'anon-key-for-local-e2e-0000000000' } });
  expect(r.ok()).toBe(true);
});

test('shared database: sign-in, setup, two phones, offline bill, fingerprint, void, 3 months', async ({ browser }) => {
  // ---------- Phone 1: the owner ----------
  const ctx1 = await browser.newContext();
  const p1 = await ctx1.newPage();
  const errors1 = watchErrors(p1);
  await addFingerprintSensor(ctx1, p1);
  await p1.goto('./');
  await expect(p1.getByRole('heading', { name: 'Sign in to Tikka Bites' })).toBeVisible();
  await expect(p1.locator('#app')).toHaveAttribute('inert', ''); // nothing usable behind it

  await signIn(p1, 'owner', 'wrong-password');
  await expect(p1.getByRole('alert')).toHaveText('Wrong User ID or password.');
  await signIn(p1, 'owner', 'owner-pass-123');

  await expect(p1.getByRole('heading', { name: 'Unlock with fingerprint?' })).toBeVisible();
  await p1.getByRole('button', { name: 'Use fingerprint' }).click();

  await expect(p1.getByRole('heading', { name: 'Set up the shared database' })).toBeVisible();
  await p1.getByRole('button', { name: 'Set up from this phone' }).click();
  await appReady(p1);
  await expect(pill(p1)).toHaveText('Synced', { timeout: 30_000 });

  await p1.getByRole('link', { name: 'Menu', exact: true }).click();
  await p1.getByRole('button', { name: /Load Tikka Bites menu/ }).click();
  await expect(p1.locator('.dish-row')).toHaveCount(40);
  expect(psql('select count(*) from public.menu')).toBe('40'); // really in the shared database

  const first = await billOne(p1, 'Chicken Tikka Wrap');
  expect(first.no).toMatch(/^RCPT-\d{4}-0001$/); // numbered by the server
  await first.dialog.getByRole('button', { name: 'Done' }).click();

  // ---------- Phone 2: a counter phone ----------
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  const errors2 = watchErrors(p2);
  await p2.goto('./');
  await signIn(p2, 'counter1', 'counter-pass-123');
  // A PC with Windows Hello reports a sensor too: then the offer shows; decline it here.
  const notNow = p2.getByRole('button', { name: 'Not now' });
  await notNow.waitFor({ timeout: 5000 }).then(() => notNow.click(), () => undefined);
  await appReady(p2);
  await p2.getByRole('link', { name: 'Menu', exact: true }).click();
  await expect(p2.locator('.dish-row')).toHaveCount(40); // the shared menu arrived

  // Internet cut: billing goes on with a temporary number.
  await ctx2.setOffline(true);
  const off = await billOne(p2, 'Full Chicken');
  expect(off.no).toMatch(/^OFF-[A-Z0-9]{3}-0001$/);
  await expect(off.dialog.locator('.r-offline')).toContainText('Made offline');
  await off.dialog.getByRole('button', { name: 'Done' }).click();
  await expect(pill(p2)).toContainText(/Offline|waiting/);

  // Menu changes need the internet.
  await p2.getByRole('link', { name: 'Menu', exact: true }).click();
  await p2.locator('.dish-row').first().getByRole('switch').click();
  await expect(p2.locator('.toast-error').last()).toContainText('need the internet');

  // Back online: the offline bill uploads and gets its final number.
  await ctx2.setOffline(false);
  await expect(pill(p2)).toHaveText('Synced', { timeout: 30_000 });
  const finalNo = psql(`select bill_no from public.bills where data->>'printedAs' = '${off.no}'`);
  expect(finalNo).toMatch(/^RCPT-\d{4}-0002$/);
  await p2.getByRole('link', { name: 'Reports', exact: true }).click();
  const row = p2.locator('.bill-row', { hasText: finalNo });
  await expect(row).toBeVisible();
  await expect(p2.locator('.bill-row', { hasText: off.no })).toHaveCount(0); // the temporary bill was replaced
  await row.getByRole('button', { name: /View/ }).click();
  await expect(p2.locator('dialog[open] .receipt')).toContainText(`Printed as${off.no}`.replace('as', 'as'));
  await p2.locator('dialog[open]').getByRole('button', { name: 'Done' }).click();

  // ---------- Phone 1 again: fingerprint unlock, sees phone 2's bill, voids it ----------
  await p1.reload();
  await expect(p1.getByRole('heading', { name: 'Welcome back, owner' })).toBeVisible();
  await p1.getByRole('button', { name: 'Unlock with fingerprint' }).click();
  await appReady(p1);
  await expect(pill(p1)).toHaveText('Synced', { timeout: 30_000 });
  await p1.getByRole('link', { name: 'Reports', exact: true }).click();
  const kpiBills = (p: Page) => p.locator('.kpi', { hasText: 'Bills' }).locator('.kpi-value');
  await expect(kpiBills(p1)).toHaveText('2');
  await p1.locator('.bill-row', { hasText: finalNo }).getByRole('button', { name: /Void/ }).click();
  await p1.locator('#void-reason').fill('Entered twice');
  await p1.getByRole('button', { name: 'Void bill' }).click();
  await expect(kpiBills(p1)).toHaveText('1');
  expect(psql(`select status from public.bills where bill_no = '${finalNo}'`)).toBe('void');

  // Phone 2 learns about the void on its next sync.
  await p2.reload();
  await appReady(p2);
  await expect(pill(p2)).toHaveText('Synced', { timeout: 30_000 });
  await p2.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(kpiBills(p2)).toHaveText('1');

  // ---------- Only 3 months are kept ----------
  const old = psql("select to_char(date_trunc('month', now() at time zone 'Asia/Kolkata') - interval '3 months', 'YYYYMM')");
  psql(`insert into public.bills (bill_no, created_at, month_key, status, data) values ('RCPT-${old}-0001', 1, '${old}', 'paid',
        jsonb_build_object('billNo', 'RCPT-${old}-0001', 'createdAt', 1, 'monthKey', '${old}', 'hour', 12, 'weekday', 1, 'items', '[]'::jsonb,
          'orderType', 'takeaway', 'paymentMode', 'cash', 'discount', '{"kind":"flat","paise":0}'::jsonb, 'subtotalPaise', 0, 'discountPaise', 0,
          'roundOffPaise', 0, 'totalPaise', 0, 'itemCount', 0, 'categories', '[]'::jsonb, 'hasVeg', false, 'hasNonVeg', false, 'cheesyLine', '', 'status', 'paid'))`);
  await p2.reload();
  await appReady(p2);
  await expect(pill(p2)).toHaveText('Synced', { timeout: 30_000 });
  await expect.poll(() => psql(`select count(*) from public.bills where month_key = '${old}'`)).toBe('0'); // server cleared it
  const onPhone = await p2.evaluate(
    (no) =>
      new Promise<boolean>((resolve) => {
        const req = indexedDB.open('restobill');
        req.onsuccess = () => {
          const get = req.result.transaction('bills').objectStore('bills').get(no);
          get.onsuccess = () => resolve(get.result !== undefined);
        };
      }),
    `RCPT-${old}-0001`,
  );
  expect(onPhone).toBe(false); // and the phone's copy doesn't keep it either

  // ---------- Sign out ----------
  await p2.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(p2.getByText('Signed in as counter1')).toBeVisible();
  await p2.getByRole('button', { name: 'Sign out' }).click();
  await p2.locator('dialog[open]').getByRole('button', { name: 'Sign out' }).click();
  await expect(p2.getByRole('heading', { name: 'Sign in to Tikka Bites' })).toBeVisible();

  expect(errors1).toEqual([]);
  expect(errors2).toEqual([]);
  await ctx1.close();
  await ctx2.close();
});
