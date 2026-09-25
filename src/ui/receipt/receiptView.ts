import { h, replaceChildren } from '../dom';
import { openModal } from '../components/modal';
import { segmented } from '../components/form';
import { icon } from '../components/icons';
import { buildReceipt } from './receipt';
import { whatsappUrl } from './whatsapp';
import { getSettings } from '../../db/settingsRepo';
import type { Bill, ReceiptWidth, Settings } from '../../db/types';

/** Put the receipt into the hidden #print-root that @media print shows. */
function preparePrint(bill: Bill, s: Settings, width: ReceiptWidth): void {
  const root = document.getElementById('print-root');
  if (!root) return;
  root.className = `print-root print-w${width}`;
  replaceChildren(root, buildReceipt(bill, s, width));
}

function clearPrint(): void {
  const root = document.getElementById('print-root');
  if (root) root.replaceChildren();
}

/**
 * Receipt preview with format picker, Print (browser dialog → printer or
 * "Save as PDF") and WhatsApp share. Reprints use the stored bill, so the
 * same cheesy line and prices appear every time.
 */
export async function showReceipt(bill: Bill, opts: { autoPrint?: boolean } = {}): Promise<void> {
  const s = await getSettings();
  let width: ReceiptWidth = s.receiptWidth;

  const preview = h('div', { class: 'receipt-preview' });
  const render = () => {
    replaceChildren(preview, buildReceipt(bill, s, width));
    preparePrint(bill, s, width);
  };
  const format = segmented('rformat', 'Paper size', [['58', '58 mm'], ['80', '80 mm'], ['A4', 'A4']], width);
  format.el.addEventListener('change', () => {
    width = format.get() as ReceiptWidth;
    render();
  });

  const print = h('button', { class: 'btn btn-primary', attrs: { type: 'button' } }, icon('print', 18), 'Print');
  const wa = h('a', {
    class: 'btn btn-wa',
    attrs: { href: whatsappUrl(bill, s), target: '_blank', rel: 'noopener noreferrer' },
  }, icon('share', 18), 'WhatsApp');
  const done = h('button', { class: 'btn', text: 'Done', attrs: { type: 'button' } });

  const body = h('div', { class: 'receipt-modal' },
    h('div', { class: 'receipt-toolbar' }, h('span', { class: 'field-label', text: 'Paper' }), format.el),
    preview,
    h('p', { class: 'field-hint', text: 'Tip: choose "Save as PDF" as the printer to get a PDF.' }),
  );
  const m = openModal({ title: `Bill ${bill.billNo}`, body, actions: [done, wa, print], wide: true, onClose: clearPrint });
  done.addEventListener('click', m.close);
  print.addEventListener('click', () => window.print());
  render();
  print.focus();
  if (opts.autoPrint) requestAnimationFrame(() => setTimeout(() => window.print(), 50));
}
