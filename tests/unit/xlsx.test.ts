import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { zip, workbookParts, buildXlsx, colName, safeSheetName, xmlEscape, excelTime, XLSX_MIME, type Sheet } from '../../src/core/xlsx';
import { unzip, cells } from '../helpers/unzip';
import { resetDBForTests } from '../../src/db/db';
import { saveBill, voidBill } from '../../src/db/billRepo';
import { addDish } from '../../src/db/menuRepo';
import { collectExport, exportFileName } from '../../src/ui/reports/exportExcel';
import { monthRange } from '../../src/core/dates';
import { NO_DISCOUNT } from '../../src/core/totals';

const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

describe('helpers', () => {
  it('column letters', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(colName)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
  it('sheet names are Excel-safe and unique', () => {
    const taken = new Set<string>();
    expect(safeSheetName('Bills', taken)).toBe('Bills');
    expect(safeSheetName('bills', taken)).toBe('bills (2)');
    expect(safeSheetName('a/b:c*d?[e]', taken)).toBe('a b c d  e');
    expect(safeSheetName('x'.repeat(40), taken)).toHaveLength(31);
  });
  it('XML escaping keeps emoji, drops control characters and lone surrogates', () => {
    expect(xmlEscape('<b>"Tom & Jerry"</b>')).toBe('&lt;b&gt;&quot;Tom &amp; Jerry&quot;&lt;/b&gt;');
    expect(xmlEscape('ok 😋\u0001\uD800!')).toBe('ok 😋!');
  });
  it('time fractions', () => {
    expect(excelTime(+new Date(2026, 0, 1, 12, 0))).toBe(0.5);
    expect(excelTime(+new Date(2026, 0, 1, 0, 0))).toBe(0);
  });
});

describe('zip container', () => {
  it('round-trips through an independent reader with valid CRCs (deflate + store)', async () => {
    const files: [string, string][] = [['a.xml', '<x>' + 'hello '.repeat(500) + '</x>'], ['b/c.txt', 'ok ₹ 😋']];
    const out = unzip(await zip(files));
    expect(out.get('a.xml')).toBe(files[0]![1]);
    expect(out.get('b/c.txt')).toBe('ok ₹ 😋');
  });
});

describe('workbook', () => {
  const sheet: Sheet = {
    name: 'Bills',
    title: ['Tikka Bites — Sales report'],
    columns: [
      { header: 'Bill No', type: 'text', width: 18 },
      { header: 'Date', type: 'date', width: 12 },
      { header: 'Time', type: 'time', width: 8 },
      { header: 'Qty', type: 'int', width: 6 },
      { header: 'Total', type: 'money', width: 12 },
    ],
    rows: [
      ['INV-202602-0001', +new Date(2026, 1, 1, 0, 30), +new Date(2026, 1, 1, 0, 30), 2, 300.5],
      ['=HYPERLINK("http://evil")', null, undefined, 1, -0.4],
    ],
  };

  it('has every required part and valid content types', async () => {
    const files = unzip(await bytes(await buildXlsx([sheet])));
    expect([...files.keys()].sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    expect(files.get('[Content_Types].xml')).toContain('/xl/worksheets/sheet1.xml');
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="Bills" sheetId="1" r:id="rId1"/>');
    expect(XLSX_MIME).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('writes typed cells: text, real dates, times, integers and ₹ amounts', async () => {
    const files = unzip(await bytes(await buildXlsx([sheet])));
    const xml = files.get('xl/worksheets/sheet1.xml')!;
    const c = cells(xml);
    expect(c['A1']).toBe('Tikka Bites — Sales report'); // title
    expect(c['A3']).toBe('Bill No'); // header row after a blank spacer
    expect(c['A4']).toBe('INV-202602-0001');
    expect(c['B4']).toBe(46054); // 01-02-2026 as an Excel date
    expect(c['C4']).toBeCloseTo(30 / 1440, 10); // 00:30
    expect(c['D4']).toBe(2);
    expect(c['E4']).toBe(300.5);
    expect(c['E5']).toBe(-0.4);
    expect(xml).toContain('<c r="B4" s="2">'); // date style
    expect(xml).toContain('<c r="E4" s="4">'); // ₹ money style
    expect(xml).toContain('state="frozen"'); // header stays visible when scrolling
    expect(xml).toContain('<autoFilter ref="A3:E5"/>');
    expect(files.get('xl/styles.xml')).toContain('dd\\-mm\\-yyyy');
  });

  it('never writes formulas: text that looks like a formula stays text', async () => {
    const xml = unzip(await bytes(await buildXlsx([sheet]))).get('xl/worksheets/sheet1.xml')!;
    expect(xml).not.toContain('<f>');
    expect(cells(xml)['A5']).toBe('=HYPERLINK("http://evil")');
    expect(cells(xml)['B5']).toBeUndefined(); // empty cells are omitted
  });

  it('splits a sheet that exceeds Excel’s row limit', () => {
    const big: Sheet = { name: 'Items', columns: [{ header: 'n', type: 'int', width: 5 }], rows: Array.from({ length: 1_048_576 + 10 }, (_, i) => [i]) };
    const parts = workbookParts([big]);
    const wb = parts.find(([p]) => p === 'xl/workbook.xml')![1];
    expect(wb).toContain('name="Items"');
    expect(wb).toContain('name="Items (2)"');
  });
});

describe('sales export', () => {
  let dish: number;
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    await resetDBForTests();
    dish = (await addDish({ name: 'Full Chicken', category: 'Grill Gali', pricePaise: 45000, isVeg: false, active: true })).id;
    await saveBill({ items: [{ menuId: dish, qty: 2 }], orderType: 'dine-in', tableNo: '4', customerName: 'Asha & Co <VIP>', paymentMode: 'upi', discount: { kind: 'pct', bp: 1000 } }, +new Date(2026, 8, 3, 13, 5));
    const v = await saveBill({ items: [{ menuId: dish, qty: 1 }], orderType: 'takeaway', paymentMode: 'cash', discount: NO_DISCOUNT }, +new Date(2026, 8, 4, 20, 0));
    await voidBill(v.billNo, 'Customer cancelled');
  });

  it('Summary, Bills, Items and Dish Sales sheets with correct totals', async () => {
    const { sheets, bills, items } = await collectExport({ range: monthRange(2026, 8), showVoid: false }, 'This month', 'Tikka Bites', +new Date(2026, 8, 25, 18, 0));
    expect(sheets.map((s) => s.name)).toEqual(['Summary', 'Bills', 'Items', 'Dish Sales']);
    expect(bills).toBe(1); // the voided bill is left out unless "include voided" is on
    expect(items).toBe(1);
    const summary = Object.fromEntries(sheets[0]!.rows.map((r) => [r[0], r[1] ?? r[2]]));
    expect(summary).toMatchObject({ 'Total revenue': 810, 'Discounts given': 90, 'Bills (paid)': 1, 'Bills voided (not in totals)': 1, 'Items sold': 2 });
    expect(sheets[0]!.title).toContain('Period: This month (01/09/2026 to 30/09/2026)');
    expect(sheets[1]!.rows[0]).toEqual(['INV-202609-0001', +new Date(2026, 8, 3, 13, 5), +new Date(2026, 8, 3, 13, 5), 'Paid', 'Dine-in', '4', 'Asha & Co <VIP>', 'UPI', '2 × Full Chicken', 2, 900, 90, 0, 810, '']);
    expect(sheets[3]!.rows).toEqual([[1, 'Full Chicken', 'Grill Gali', 2, 900]]);
  });

  it('includes voided bills (marked Void, with reason) when asked, but never in totals', async () => {
    const { sheets } = await collectExport({ range: monthRange(2026, 8), showVoid: true }, 'This month', 'Tikka Bites');
    const voided = sheets[1]!.rows.find((r) => r[3] === 'Void')!;
    expect(voided[14]).toBe('Customer cancelled');
    expect(sheets[0]!.rows.find((r) => r[0] === 'Total revenue')![1]).toBe(810);
  });

  it('produces a real .xlsx file name for the period', () => {
    expect(exportFileName({ range: monthRange(2026, 8), showVoid: false })).toBe('Tikka-Bites-sales_2026-09-01_to_2026-09-30.xlsx');
  });
});
