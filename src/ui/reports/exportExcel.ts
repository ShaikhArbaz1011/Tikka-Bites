import { forEachBill } from '../../db/billRepo';
import { buildXlsx, type Cell, type Sheet } from '../../core/xlsx';
import { formatDateISO, formatDateTime } from '../../core/dates';
import { billMatches, itemFilterFor, type ReportFilter } from './query';
import { downloadBlob } from '../download';
import { ORDER_LABEL, PAYMENT_LABEL } from '../receipt/receipt';

const rupees = (paise: number) => paise / 100; // display value only; sums stay exact in paise below

export interface ExportResult {
  bills: number;
  items: number;
  fileName: string;
}

/** Everything needed to write the workbook, from ONE pass over the bills in range. Exported for tests. */
export async function collectExport(f: ReportFilter, label: string, restaurant: string, now = Date.now()): Promise<{ sheets: Sheet[]; bills: number; items: number }> {
  const billRows: Cell[][] = [];
  const itemRows: Cell[][] = [];
  const dishes = new Map<string, { name: string; category: string; qty: number; paise: number }>();
  const itemFilter = itemFilterFor(f);
  let paidBills = 0;
  let voidBills = 0;
  let revenue = 0;
  let discount = 0;
  let itemsSold = 0;

  await forEachBill(f.range, (b) => {
    if (!billMatches(b, f)) return;
    const paid = b.status === 'paid';
    if (!paid) voidBills++;
    if (!paid && !f.showVoid) return;
    if (paid) {
      paidBills++;
      revenue += b.totalPaise;
      discount += b.discountPaise;
    }
    billRows.push([
      b.billNo, b.createdAt, b.createdAt, paid ? 'Paid' : 'Void', ORDER_LABEL[b.orderType], b.tableNo ?? '', b.customerName ?? '',
      PAYMENT_LABEL[b.paymentMode], b.items.map((i) => `${i.qty} × ${i.name}`).join(', '), b.itemCount,
      rupees(b.subtotalPaise), rupees(b.discountPaise), rupees(b.roundOffPaise), rupees(b.totalPaise), b.voidReason ?? '',
    ]);
    for (const i of b.items) {
      if (itemFilter && !itemFilter(i)) continue;
      itemRows.push([b.billNo, b.createdAt, b.createdAt, paid ? 'Paid' : 'Void', i.name, i.category, i.isVeg ? 'Veg' : 'Non-veg', i.qty, rupees(i.unitPaise), rupees(i.linePaise)]);
      if (!paid) continue;
      itemsSold += i.qty;
      const key = String(i.menuId);
      const d = dishes.get(key) ?? { name: i.name, category: i.category, qty: 0, paise: 0 };
      d.qty += i.qty;
      d.paise += i.linePaise;
      dishes.set(key, d);
    }
  });

  const filters = [
    f.category && `Category: ${f.category}`,
    f.payment && `Payment: ${PAYMENT_LABEL[f.payment]}`,
    f.orderType && `Order type: ${ORDER_LABEL[f.orderType]}`,
    f.food && (f.food === 'veg' ? 'Veg only' : 'Non-veg only'),
    f.minPaise !== undefined && `Min ₹${rupees(f.minPaise)}`,
    f.maxPaise !== undefined && `Max ₹${rupees(f.maxPaise)}`,
    f.billNo && `Bill no. contains ${f.billNo}`,
  ].filter(Boolean);
  const period = `${formatDateTime(f.range.start).slice(0, 10)} to ${formatDateTime(f.range.end - 1).slice(0, 10)}`;
  const periodLine = label.includes(period.slice(0, 10)) ? `Period: ${period}` : `Period: ${label} (${period})`;
  const title = [`${restaurant} — Sales report`, periodLine, `Filters: ${filters.length ? filters.join(', ') : 'none'}`, `Exported: ${formatDateTime(now)}`];

  const summarySheet: Sheet = {
    name: 'Summary',
    title,
    columns: [
      { header: 'Measure', type: 'text', width: 30 },
      { header: 'Amount (₹)', type: 'money', width: 18 },
      { header: 'Count', type: 'int', width: 12 },
    ],
    rows: [
      ['Total revenue', rupees(revenue), null],
      ['Discounts given', rupees(discount), null],
      ['Average bill', paidBills ? rupees(Math.round(revenue / paidBills)) : 0, null],
      ['Bills (paid)', null, paidBills],
      ['Bills voided (not in totals)', null, voidBills],
      ['Items sold', null, itemsSold],
    ],
  };

  const dishRows = [...dishes.values()]
    .sort((a, b) => b.qty - a.qty || b.paise - a.paise || a.name.localeCompare(b.name))
    .map((d, i): Cell[] => [i + 1, d.name, d.category, d.qty, rupees(d.paise)]);

  const sheets: Sheet[] = [
    summarySheet,
    {
      name: 'Bills',
      columns: [
        { header: 'Bill No', type: 'text', width: 18 },
        { header: 'Date', type: 'date', width: 12 },
        { header: 'Time', type: 'time', width: 8 },
        { header: 'Status', type: 'text', width: 8 },
        { header: 'Order Type', type: 'text', width: 11 },
        { header: 'Table', type: 'text', width: 7 },
        { header: 'Customer', type: 'text', width: 18 },
        { header: 'Payment', type: 'text', width: 9 },
        { header: 'Items', type: 'text', width: 48 },
        { header: 'Item Count', type: 'int', width: 11 },
        { header: 'Subtotal', type: 'money', width: 13 },
        { header: 'Discount', type: 'money', width: 12 },
        { header: 'Round Off', type: 'money', width: 11 },
        { header: 'Total', type: 'money', width: 13 },
        { header: 'Void Reason', type: 'text', width: 24 },
      ],
      rows: billRows,
    },
    {
      name: 'Items',
      columns: [
        { header: 'Bill No', type: 'text', width: 18 },
        { header: 'Date', type: 'date', width: 12 },
        { header: 'Time', type: 'time', width: 8 },
        { header: 'Status', type: 'text', width: 8 },
        { header: 'Dish', type: 'text', width: 36 },
        { header: 'Category', type: 'text', width: 22 },
        { header: 'Type', type: 'text', width: 9 },
        { header: 'Qty', type: 'int', width: 6 },
        { header: 'Rate', type: 'money', width: 11 },
        { header: 'Amount', type: 'money', width: 12 },
      ],
      rows: itemRows,
    },
    {
      name: 'Dish Sales',
      columns: [
        { header: 'Rank', type: 'int', width: 6 },
        { header: 'Dish', type: 'text', width: 36 },
        { header: 'Category', type: 'text', width: 22 },
        { header: 'Qty Sold', type: 'int', width: 10 },
        { header: 'Revenue', type: 'money', width: 14 },
      ],
      rows: dishRows,
    },
  ];
  return { sheets, bills: billRows.length, items: itemRows.length };
}

export function exportFileName(f: ReportFilter): string {
  return `Tikka-Bites-sales_${formatDateISO(f.range.start)}_to_${formatDateISO(f.range.end - 1)}.xlsx`;
}

/** Export the current filtered view as one Excel workbook (Summary, Bills, Items, Dish Sales). */
export async function exportExcel(f: ReportFilter, label: string, restaurant: string): Promise<ExportResult> {
  const { sheets, bills, items } = await collectExport(f, label, restaurant);
  const fileName = exportFileName(f);
  downloadBlob(await buildXlsx(sheets), fileName);
  return { bills, items, fileName };
}
