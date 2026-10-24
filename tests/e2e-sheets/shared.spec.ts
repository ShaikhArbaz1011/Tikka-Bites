import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { appReady, resetSheets, sheets, signIn, watchErrors, SHEETS } from './helpers';

/**
 * Google Sheets mode, end to end: two "phones" (browser contexts) use the real app against
 * scripts/fake-sheets.mjs, which runs the real google-sheets/Code.gs. Every change must be
 * in Main and in Backup; old months leave Main but stay in Backup.
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

test.beforeEach(resetSheets);

test.afterEach(async () => {
  const s = await sheets();
  expect(s.violations).toEqual([]); // nothing written without the lock, always flushed
  expect(s.formulaWrites).toBe(0);
});

test('Google Sheets: sign-in, setup, two phones, offline bill, fingerprint, void, 3 months', async ({ browser }) => {
  // ---------- Phone 1: the owner ----------
  const ctx1 = await browser.newContext();
  const p1 = await ctx1.newPage();
  const errors1 = watchErrors(p1);
  await addFingerprintSensor(ctx1, p1);
  await p1.goto('./');
  await expect(p1.getByRole('heading', { name: 'Sign in to Tikka Bites' })).toBeVisible();

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
  let s = await sheets();
  expect(s.main.menu).toHaveLength(40); // really in the Google Sheet…
  expect(s.backup.menu).toHaveLength(40); // …and in the Backup

  const first = await billOne(p1, 'Chicken Tikka Wrap');
  expect(first.no).toMatch(/^RCPT-\d{4}-0001$/); // numbered by the sheet
  await first.dialog.getByRole('button', { name: 'Done' }).click();

  // ---------- Phone 2: a counter phone ----------
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  const errors2 = watchErrors(p2);
  await p2.goto('./');
  await signIn(p2, 'counter1', 'counter-pass-123');
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

  // Back online: the offline bill uploads and gets its final number (once).
  await ctx2.setOffline(false);
  await expect(pill(p2)).toHaveText('Synced', { timeout: 30_000 });
  s = await sheets();
  const uploaded = s.main.bills.filter((b) => b.printedAs === off.no);
  expect(uploaded).toHaveLength(1);
  const finalNo = uploaded[0]!.billNo;
  expect(finalNo).toMatch(/^RCPT-\d{4}-0002$/);
  expect(uploaded[0]!.savedBy).toBe('counter1');
  await p2.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(p2.locator('.bill-row', { hasText: finalNo })).toBeVisible();
  await expect(p2.locator('.bill-row', { hasText: off.no })).toHaveCount(0); // the temporary bill was replaced

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
  s = await sheets();
  expect(s.main.bills.find((b) => b.billNo === finalNo)?.status).toBe('void');
  expect(s.backup.bills.find((b) => b.billNo === finalNo)?.status).toBe('void');

  // Phone 2 learns about the void on its next sync.
  await p2.reload();
  await appReady(p2);
  await expect(pill(p2)).toHaveText('Synced', { timeout: 30_000 });
  await p2.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(kpiBills(p2)).toHaveText('1');

  // ---------- 3 months in Main; the Backup keeps every month ----------
  const d = new Date();
  const old = new Date(d.getFullYear(), d.getMonth() - 3, 1);
  const oldMonth = `${old.getFullYear()}${String(old.getMonth() + 1).padStart(2, '0')}`;
  const oldNo = ((await (await fetch(`${SHEETS}/__test/old-bill`, { method: 'POST', body: JSON.stringify({ month: oldMonth }) })).json()) as { billNo: string }).billNo;
  await p2.reload();
  await appReady(p2);
  await expect(pill(p2)).toHaveText('Synced', { timeout: 30_000 });
  await expect.poll(async () => (await sheets()).main.bills.filter((b) => b.monthKey === oldMonth).length).toBe(0); // cleared from Main
  expect((await sheets()).backup.bills.map((b) => b.billNo)).toContain(oldNo); // kept in the Backup
  const onPhone = await p2.evaluate(
    (no) =>
      new Promise<boolean>((resolve) => {
        const req = indexedDB.open('restobill');
        req.onsuccess = () => {
          const get = req.result.transaction('bills').objectStore('bills').get(no);
          get.onsuccess = () => resolve(get.result !== undefined);
        };
      }),
    oldNo,
  );
  expect(onPhone).toBe(false);

  // ---------- Main and Backup hold the same bills for the kept months ----------
  s = await sheets();
  const kept = (list: { billNo: string; status: string; monthKey: string }[]) => list.filter((b) => b.monthKey !== oldMonth).map((b) => `${b.billNo} ${b.status}`).sort();
  expect(kept(s.backup.bills)).toEqual(kept(s.main.bills));

  // ---------- Sign out (this phone only) ----------
  await p2.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(p2.getByText('Signed in as counter1')).toBeVisible();
  await expect(p2.getByText('Older months stay in the Backup Google Sheet')).toBeVisible();
  await p2.getByRole('button', { name: 'Sign out' }).click();
  await p2.locator('dialog[open]').getByRole('button', { name: 'Sign out' }).click();
  await expect(p2.getByRole('heading', { name: 'Sign in to Tikka Bites' })).toBeVisible();

  expect(errors1).toEqual([]);
  expect(errors2).toEqual([]);
  await ctx1.close();
  await ctx2.close();
});
