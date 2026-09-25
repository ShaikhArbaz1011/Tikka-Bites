import { h } from '../dom';
import { formatINR } from '../../core/money';
import { formatDateTime } from '../../core/dates';
import type { Bill, ReceiptWidth, Settings } from '../../db/types';
import { BUILT_IN_LOGO } from '../../db/db';

export const ORDER_LABEL = { 'dine-in': 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' } as const;
export const PAYMENT_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card' } as const;

/** Build the receipt DOM. Everything is set via textContent (XSS-safe). */
export function buildReceipt(bill: Bill, s: Settings, width: ReceiptWidth): HTMLElement {
  const m = (p: number) => formatINR(p, s.currencySymbol);
  const row = (label: string, value: string, cls = '') =>
    h('div', { class: `r-row ${cls}` }, h('span', { text: label }), h('span', { class: 'r-num', text: value }));

  const orderLine = bill.orderType === 'dine-in' && bill.tableNo ? `Dine-in · Table ${bill.tableNo}` : ORDER_LABEL[bill.orderType];
  const discLabel = bill.discount.kind === 'pct' ? `Discount (${bill.discount.bp / 100}%)` : 'Discount';

  return h(
    'article',
    { class: `receipt w${width}${bill.status === 'void' ? ' is-void' : ''}`, attrs: { 'aria-label': `Receipt ${bill.billNo}` } },
    h(
      'header',
      { class: 'r-head' },
      s.printLogo !== false ? h('img', { class: 'r-logo', attrs: { src: s.logoDataUrl ?? BUILT_IN_LOGO, alt: '', width: 300, height: 300 } }) : null,
      h('div', { class: 'r-name', text: s.name }),
      s.address ? h('div', { class: 'r-addr', text: s.address }) : null,
      s.phone ? h('div', { class: 'r-addr', text: `Ph: ${s.phone}` }) : null,
    ),
    bill.status === 'void' ? h('div', { class: 'r-void', text: `VOID — ${bill.voidReason ?? ''}` }) : null,
    h(
      'div',
      { class: 'r-meta' },
      row('Bill No', bill.billNo),
      row('Date', formatDateTime(bill.createdAt)),
      row('Order', orderLine),
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
      bill.discountPaise ? row(discLabel, `−${m(bill.discountPaise)}`) : null,
      bill.roundOffPaise ? row('Round off', `${bill.roundOffPaise < 0 ? '−' : '+'}${m(Math.abs(bill.roundOffPaise))}`) : null,
      row('TOTAL', m(bill.totalPaise), 'r-grand'),
      row('Paid by', PAYMENT_LABEL[bill.paymentMode]),
    ),
    h('footer', { class: 'r-foot' }, h('p', { class: 'r-cheesy', text: bill.cheesyLine }), h('p', { class: 'r-thanks', text: 'Thank you! Visit again.' })),
  );
}
