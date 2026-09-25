import { h, replaceChildren } from '../dom';
import { icon } from '../components/icons';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import { listBillsPage, voidBill, getBill, BillError, type PageCursor } from '../../db/billRepo';
import { billMatches, type ReportFilter } from './query';
import { formatINR } from '../../core/money';
import { formatDateTime } from '../../core/dates';
import { LIMITS } from '../../core/validate';
import { ORDER_LABEL, PAYMENT_LABEL } from '../receipt/receipt';
import type { Bill } from '../../db/types';

const PAGE = 50;

/** Newest-first bill list, 50 at a time, with View/Reprint and Void. */
export function billList(onChanged: () => void): { el: HTMLElement; load(f: ReportFilter, symbol: string): void; destroy(): void } {
  const list = h('ul', { class: 'bill-list', attrs: { 'aria-label': 'Bills' } });
  const status = h('p', { class: 'muted list-status', attrs: { role: 'status' } });
  const more = h('button', { class: 'btn', text: 'Load 50 more', attrs: { type: 'button' } });
  const sentinel = h('div', { class: 'sentinel' });
  const el = h('div', { class: 'bill-list-wrap' }, list, status, more, sentinel);
  const byNo = new Map<string, Bill>();

  let filter: ReportFilter | undefined;
  let sym = '₹';
  let next: PageCursor | undefined;
  let loading = false;
  let token = 0;
  let shown = 0;

  const row = (b: Bill) =>
    h(
      'li',
      { class: `bill-row${b.status === 'void' ? ' is-void' : ''}`, dataset: { no: b.billNo } },
      h('div', { class: 'bill-row-main' },
        h('span', { class: 'bill-no', text: b.billNo }),
        h('span', { class: 'muted bill-when', text: formatDateTime(b.createdAt) })),
      h('span', { class: 'bill-meta muted', text: `${ORDER_LABEL[b.orderType]}${b.tableNo ? ` · T${b.tableNo}` : ''} · ${PAYMENT_LABEL[b.paymentMode]} · ${b.itemCount} item${b.itemCount === 1 ? '' : 's'}` }),
      b.status === 'void' ? h('span', { class: 'badge badge-void', text: 'VOID', attrs: { title: b.voidReason ?? '' } }) : null,
      h('span', { class: 'bill-total', text: formatINR(b.totalPaise, sym) }),
      h('div', { class: 'bill-actions' },
        h('button', { class: 'btn btn-sm', attrs: { type: 'button', 'data-action': 'view', 'aria-label': `View or reprint ${b.billNo}` } }, icon('print', 16), 'View'),
        b.status === 'paid'
          ? h('button', { class: 'btn btn-sm btn-danger', text: 'Void', attrs: { type: 'button', 'data-action': 'void', 'aria-label': `Void ${b.billNo}` } })
          : null),
    );

  const page = async () => {
    if (!filter || loading) return;
    loading = true;
    const my = token;
    const f = filter;
    try {
      const res = await listBillsPage(f.range, PAGE, next, (b) => (f.showVoid || b.status === 'paid') && billMatches(b, f));
      if (my !== token) return;
      for (const b of res.bills) byNo.set(b.billNo, b);
      list.append(...res.bills.map(row));
      shown += res.bills.length;
      next = res.next;
      more.hidden = !next;
      status.textContent = shown === 0 ? 'No bills in this range.' : `Showing ${shown.toLocaleString('en-IN')} bill${shown === 1 ? '' : 's'}${next ? '' : ' — end of list'}`;
    } finally {
      loading = false;
    }
  };

  // Auto-load the next page when the end of the list scrolls into view.
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && next) void page();
  }, { rootMargin: '400px' });
  io.observe(sentinel);
  more.addEventListener('click', () => void page());

  list.addEventListener('click', async (e) => {
    const btn = (e.target as Element).closest<HTMLElement>('[data-action]');
    const no = btn?.closest<HTMLElement>('.bill-row')?.dataset['no'];
    if (!btn || !no) return;
    const bill = byNo.get(no) ?? (await getBill(no));
    if (!bill) return;
    if (btn.dataset['action'] === 'view') {
      const { showReceipt } = await import('../receipt/receiptView');
      void showReceipt(bill);
    } else if (btn.dataset['action'] === 'void') openVoid(bill);
  });

  const openVoid = (bill: Bill) => {
    const reason = h('textarea', { class: 'input', attrs: { id: 'void-reason', maxlength: LIMITS.voidReason, rows: 3, required: true, 'aria-describedby': 'void-err' } });
    const err = h('p', { class: 'field-error', attrs: { id: 'void-err', hidden: true } });
    const cancel = h('button', { class: 'btn', text: 'Cancel', attrs: { type: 'button' } });
    const confirm = h('button', { class: 'btn btn-danger-solid', text: 'Void bill', attrs: { type: 'button' } });
    const m = openModal({
      title: `Void ${bill.billNo}?`,
      body: h('div', { class: 'form-grid' },
        h('p', { text: `Total ${formatINR(bill.totalPaise, sym)}. The bill is kept for your records but removed from all totals.` }),
        h('div', { class: 'field' }, h('label', { class: 'field-label', text: 'Reason (required)', attrs: { for: 'void-reason' } }), reason, err)),
      actions: [cancel, confirm],
    });
    reason.focus();
    cancel.addEventListener('click', m.close);
    confirm.addEventListener('click', async () => {
      try {
        confirm.disabled = true;
        await voidBill(bill.billNo, reason.value);
        m.close();
        toast(`${bill.billNo} voided`, 'success');
        onChanged();
      } catch (e2) {
        err.textContent = e2 instanceof BillError ? e2.message : 'Could not void the bill';
        err.hidden = false;
        reason.setAttribute('aria-invalid', 'true');
        confirm.disabled = false;
      }
    });
  };

  return {
    el,
    load(f, symbol) {
      token++;
      filter = f;
      sym = symbol;
      next = undefined;
      shown = 0;
      loading = false;
      byNo.clear();
      replaceChildren(list);
      status.textContent = 'Loading…';
      more.hidden = true;
      void page();
    },
    destroy() {
      io.disconnect();
    },
  };
}
