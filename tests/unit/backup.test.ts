import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { resetDBForTests } from '../../src/db/db';
import { saveBill, voidBill, getMonthlyStats, getBill } from '../../src/db/billRepo';
import { addDish, listMenu } from '../../src/db/menuRepo';
import { exportBackup, importBackup } from '../../src/db/backup';
import { validateBackup } from '../../src/core/backupSchema';
import { NO_DISCOUNT } from '../../src/core/totals';
import { saveSettings, getSettings } from '../../src/db/settingsRepo';

const SEP = +new Date(2026, 8, 25, 13, 15);

async function seed() {
  const a = await addDish({ name: 'Dosa', category: 'South', pricePaise: 12050, isVeg: true, active: true });
  const b = await addDish({ name: 'Fish Fry', category: 'Seafood', pricePaise: 34000, isVeg: false, active: true });
  await saveBill({ items: [{ menuId: a.id, qty: 3 }], orderType: 'takeaway', paymentMode: 'cash', discount: NO_DISCOUNT }, SEP);
  const v = await saveBill({ items: [{ menuId: b.id, qty: 1 }], orderType: 'dine-in', tableNo: '4', paymentMode: 'upi', discount: { kind: 'pct', bp: 500 } }, SEP + 1000);
  await saveBill({ items: [{ menuId: a.id, qty: 1 }, { menuId: b.id, qty: 2 }], orderType: 'delivery', customerName: 'Asha', paymentMode: 'upi', discount: { kind: 'flat', paise: 2000 } }, SEP + 2000);
  await voidBill(v.billNo, 'Wrong table');
  await saveSettings({ name: 'Dosa Corner', address: '12 MG Road', phone: '98765 43210' });
}

async function backupJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await (await exportBackup(SEP + 5000)).text());
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await resetDBForTests();
});

describe('backup round trip', () => {
  it('export → validate → import restores identical data and rebuilds stats', async () => {
    await seed();
    const json = await backupJson();
    const statsBefore = await getMonthlyStats('202609');
    const v = validateBackup(json);
    expect(v.ok).toBe(true);

    globalThis.indexedDB = new IDBFactory();
    await resetDBForTests();
    if (!v.ok) return;
    await importBackup(v.backup);

    expect(await getMonthlyStats('202609')).toEqual(statsBefore);
    expect((await getBill('INV-202609-0002'))!.status).toBe('void');
    expect((await listMenu()).map((d) => d.name).sort()).toEqual(['Dosa', 'Fish Fry']);
    expect((await getSettings()).name).toBe('Dosa Corner');
    // Counter continues after the restored bills.
    const next = await saveBill({ items: [{ menuId: (await listMenu())[0]!.id, qty: 1 }], orderType: 'takeaway', paymentMode: 'cash', discount: NO_DISCOUNT }, SEP);
    expect(next.billNo).toBe('INV-202609-0004');
  });
});

describe('strict import validation', () => {
  const mutate = async (fn: (j: any) => void) => {
    await seed();
    const j = await backupJson();
    fn(j);
    return validateBackup(j);
  };

  it.each<[string, (j: any) => void, RegExp]>([
    ['unknown top-level key', (j) => (j.hacker = 1), /unknown field "hacker"/],
    ['unknown key in a bill', (j) => (j.bills[0].extra = true), /unknown field "extra"/],
    ['missing field', (j) => delete j.settings.roundOff, /missing field "roundOff"/],
    ['wrong app', (j) => (j.app = 'other'), /not a RestoBill backup/],
    ['future schema version', (j) => (j.schemaVersion = 99), /unsupported version/],
    ['fractional price', (j) => (j.menu[0].pricePaise = 120.5), /whole number/],
    ['negative price', (j) => (j.menu[0].pricePaise = -1), /between/],
    ['tampered total', (j) => (j.bills[0].totalPaise += 100), /does not add up/],
    ['tampered line amount', (j) => (j.bills[0].items[0].linePaise = 1), /price × quantity/],
    ['qty out of range', (j) => (j.bills[0].items[0].qty = 1000), /between 1 and 999/],
    ['bad bill number', (j) => (j.bills[0].billNo = 'X-1'), /INV-YYYYMM-0001/],
    ['duplicate bill number', (j) => j.bills.push(structuredClone(j.bills[0])), /duplicate bill number/],
    ['bad enum', (j) => (j.bills[0].paymentMode = 'crypto'), /must be one of/],
    ['string instead of bool', (j) => (j.menu[0].isVeg = 'yes'), /true or false/],
    ['non-image logo', (j) => (j.settings.logoDataUrl = 'data:text/html;base64,PHNjcmlwdD4='), /PNG, JPEG or WEBP/],
    ['too-long name', (j) => (j.menu[0].name = 'x'.repeat(61)), /1–60 characters/],
    ['paid bill with void details', (j) => (j.bills[0].voidReason = 'x'), /cannot have void details/],
    ['void bill without reason', (j) => delete j.bills[1].voidReason, /voidReason/],
  ])('rejects %s', async (_name, fn, expected) => {
    const r = await mutate(fn);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(expected);
  });

  it('still restores old backups whose bills were paid by card', async () => {
    await seed();
    const j = await backupJson();
    (j as { bills: { paymentMode: string }[] }).bills[0]!.paymentMode = 'card';
    expect(validateBackup(j).ok).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(validateBackup(null).ok).toBe(false);
    expect(validateBackup([]).ok).toBe(false);
    expect(validateBackup('{}').ok).toBe(false);
  });
});
