import { h } from '../dom';
import { formatINR } from '../../core/money';
import { formatDateTime } from '../../core/dates';
import type { Bill, ReceiptWidth, Settings } from '../../db/types';
import { BUILT_IN_LOGO } from '../../db/db';
import { assetUrl } from '../../assets';

export const ORDER_LABEL = { 'dine-in': 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' } as const;
/** 'card' kept only so bills saved before Card was removed still print correctly. */
export const PAYMENT_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card' } as const;

/** "Dine-in · Table 4", or the order type alone. Shared by the printed receipt and the PDF. */
export function orderLine(bill: Bill): string {
  return bill.orderType === 'dine-in' && bill.tableNo ? `Dine-in · Table ${bill.tableNo}` : ORDER_LABEL[bill.orderType];
}

export function discountLabel(bill: Bill): string {
  return bill.discount.kind === 'pct' ? `Discount (${bill.discount.bp / 100}%)` : 'Discount';
}

/** Round-off with its sign, e.g. "+₹0.40" or "−₹0.25". */
export function roundOffText(paise: number, money: (p: number) => string): string {
  return `${paise < 0 ? '−' : '+'}${money(Math.abs(paise))}`;
}

/** Build the receipt DOM. Everything is set via textContent (XSS-safe). */
export function buildReceipt(bill: Bill, s: Settings, width: ReceiptWidth): HTMLElement {
  const m = (p: number) => formatINR(p, s.currencySymbol);
  const row = (label: string, value: string, cls = '') =>
    h('div', { class: `r-row ${cls}` }, h('span', { text: label }), h('span', { class: 'r-num', text: value }));

  return h(
    'article',
    { class: `receipt w${width}${bill.status === 'void' ? ' is-void' : ''}`, attrs: { 'aria-label': `Receipt ${bill.billNo}` } },
    h(
      'header',
      { class: 'r-head' },
      s.printLogo !== false ? h('img', { class: 'r-logo', attrs: { src: s.logoDataUrl ?? assetUrl(BUILT_IN_LOGO), alt: '', width: 300, height: 300 } }) : null,
      h('div', { class: 'r-name', text: s.name }),
      s.address ? h('div', { class: 'r-addr', text: s.address }) : null,
      s.phone ? h('div', { class: 'r-addr', text: `Ph: ${s.phone}` }) : null,
    ),
    bill.status === 'void' ? h('div', { class: 'r-void', text: `VOID — ${bill.voidReason ?? ''}` }) : null,
    h(
      'div',
      { class: 'r-meta' },
      row('Receipt No', bill.billNo),
      bill.printedAs ? row('Printed as', bill.printedAs) : null,
      bill.sync && bill.status === 'paid' ? h('div', { class: 'r-offline', text: 'Made offline: final receipt number is given when this phone is back online.' }) : null,
      row('Date', formatDateTime(bill.createdAt)),
      row('Order', orderLine(bill)),
      bill.customerName ? row('Customer', bill.customerName) : null,
    ),
    h(
      'table',
      { class: 'r-items' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { class: 'r-item', text: 'Item', attrs: { scope: 'col' } }),
          h('th', { class: 'r-qty', text: 'Qty', attrs: { scope: 'col' } }),
          h('th', { class: 'r-rate', text: 'Rate', attrs: { scope: 'col' } }),
          h('th', { class: 'r-amt', text: 'Amount', attrs: { scope: 'col' } }),
        ),
      ),
      h(
        'tbody',
        {},
        ...bill.items.map((it) =>
          h(
            'tr',
            {},
            h('td', { class: 'r-item', text: it.name }),
            h('td', { class: 'r-qty', text: String(it.qty) }),
            h('td', { class: 'r-rate', text: m(it.unitPaise) }),
            h('td', { class: 'r-amt', text: m(it.linePaise) }),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'r-totals' },
      row(`Subtotal (${bill.itemCount} item${bill.itemCount === 1 ? '' : 's'})`, m(bill.subtotalPaise)),
      bill.discountPaise ? row(discountLabel(bill), `−${m(bill.discountPaise)}`) : null,
      bill.roundOffPaise ? row('Round off', roundOffText(bill.roundOffPaise, m)) : null,
      row('TOTAL', m(bill.totalPaise), 'r-grand'),
      row('Paid by', PAYMENT_LABEL[bill.paymentMode]),
    ),
    h('footer', { class: 'r-foot' }, h('p', { class: 'r-cheesy', text: bill.cheesyLine }), h('p', { class: 'r-thanks', text: 'Thank you! Visit again.' })),
  );
}
