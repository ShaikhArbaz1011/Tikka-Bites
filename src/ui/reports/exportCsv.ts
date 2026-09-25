import { forEachBill } from '../../db/billRepo';
import { toCsv, CSV_BOM, type Cell } from '../../core/csv';
import { paiseToDecimal } from '../../core/money';
import { formatDateISO } from '../../core/dates';
import { billMatches, type ReportFilter } from './query';
import { downloadBlob } from '../download';
import { ORDER_LABEL, PAYMENT_LABEL } from '../receipt/receipt';
import type { Bill } from '../../db/types';

const rupees = (p: number) => Number(paiseToDecimal(p));
const pad = (n: number) => String(n).padStart(2, '0');
const time = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

async function collect(f: ReportFilter, toRows: (b: Bill) => Cell[][]): Promise<Cell[][]> {
  const rows: Cell[][] = [];
  await forEachBill(f.range, (b) => {
    if ((f.showVoid || b.status === 'paid') && billMatches(b, f)) rows.push(...toRows(b));
  });
  return rows;
}

function fileName(kind: string, f: ReportFilter): string {
  return `restobill-${kind}-${formatDateISO(f.range.start)}_to_${formatDateISO(f.range.end - 1)}.csv`;
}

/** One row per bill for the current filtered view. Opens in Excel. */
export async function exportBillsCsv(f: ReportFilter): Promise<number> {
  const rows = await collect(f, (b) => [[
    b.billNo, formatDateISO(b.createdAt), time(b.createdAt), b.status === 'void' ? 'Void' : 'Paid',
    ORDER_LABEL[b.orderType], b.tableNo ?? '', b.customerName ?? '', PAYMENT_LABEL[b.paymentMode],
    b.items.map((i) => `${i.qty}x ${i.name}`).join('; '), b.itemCount,
    rupees(b.subtotalPaise), rupees(b.discountPaise), rupees(b.roundOffPaise), rupees(b.totalPaise), b.voidReason ?? '',
  ]]);
  const header: Cell[] = ['Bill No', 'Date', 'Time', 'Status', 'Order Type', 'Table', 'Customer', 'Payment', 'Items', 'Item Count', 'Subtotal', 'Discount', 'Round Off', 'Total', 'Void Reason'];
  downloadBlob(new Blob([CSV_BOM, toCsv([header, ...rows])], { type: 'text/csv;charset=utf-8' }), fileName('bills', f));
  return rows.length;
}

/** One row per line item (for dish-level analysis in Excel). */
export async function exportItemsCsv(f: ReportFilter): Promise<number> {
  const rows = await collect(f, (b) =>
    b.items
      .filter((i) => (!f.category || i.category === f.category) && (!f.food || i.isVeg === (f.food === 'veg')))
      .map((i) => [b.billNo, formatDateISO(b.createdAt), time(b.createdAt), b.status === 'void' ? 'Void' : 'Paid', i.name, i.category, i.isVeg ? 'Veg' : 'Non-veg', i.qty, rupees(i.unitPaise), rupees(i.linePaise)]),
  );
  const header: Cell[] = ['Bill No', 'Date', 'Time', 'Status', 'Dish', 'Category', 'Type', 'Qty', 'Rate', 'Amount'];
  downloadBlob(new Blob([CSV_BOM, toCsv([header, ...rows])], { type: 'text/csv;charset=utf-8' }), fileName('items', f));
  return rows.length;
}
