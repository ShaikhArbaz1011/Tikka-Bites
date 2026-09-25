import { formatINR } from '../../core/money';
import { formatDateTime } from '../../core/dates';
import type { Bill, Settings } from '../../db/types';
import { PAYMENT_LABEL } from './receipt';

/** Plain-text bill summary for WhatsApp. */
export function whatsappText(bill: Bill, s: Settings): string {
  const m = (p: number) => formatINR(p, s.currencySymbol);
  const lines = [
    `*${s.name}*`,
    `Bill: ${bill.billNo}`,
    formatDateTime(bill.createdAt),
    '',
    ...bill.items.map((i) => `${i.qty} × ${i.name} — ${m(i.linePaise)}`),
    '',
    `Subtotal: ${m(bill.subtotalPaise)}`,
    ...(bill.discountPaise ? [`Discount: −${m(bill.discountPaise)}`] : []),
    ...(bill.roundOffPaise ? [`Round off: ${bill.roundOffPaise < 0 ? '−' : '+'}${m(Math.abs(bill.roundOffPaise))}`] : []),
    `*Total: ${m(bill.totalPaise)}* (${PAYMENT_LABEL[bill.paymentMode]})`,
    '',
    `_${bill.cheesyLine}_`,
  ];
  return lines.join('\n');
}

/** wa.me link; the user picks the contact inside WhatsApp. */
export function whatsappUrl(bill: Bill, s: Settings): string {
  return `https://wa.me/?text=${encodeURIComponent(whatsappText(bill, s))}`;
}
