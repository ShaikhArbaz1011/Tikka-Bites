import { h, replaceChildren } from '../dom';
import { openModal } from '../components/modal';
import { segmented } from '../components/form';
import { icon } from '../components/icons';
import { downloadBlob } from '../download';
import { toast } from '../components/toast';
import { buildReceipt } from './receipt';
import { receiptPdfFile } from './receiptPdf';
import { getSettings } from '../../db/settingsRepo';
import type { Bill, ReceiptWidth, Settings } from '../../db/types';

/** Put the receipt into the hidden #print-root that @media print shows. */
function preparePrint(bill: Bill, s: Settings, width: ReceiptWidth): void {
  const root = document.getElementById('print-root');
  if (!root) return;
  root.className = `print-root print-w${width}`;
  replaceChildren(root, buildReceipt(bill, s, width));
}

/** Print once every image in the receipt (the logo) has loaded, so it is never missing. */
async function printWhenReady(): Promise<void> {
  const imgs = [...document.querySelectorAll<HTMLImageElement>('#print-root img')];
  await Promise.all(imgs.map((i) => i.decode().catch(() => undefined)));
  window.print();
}

function clearPrint(): void {
  const root = document.getElementById('print-root');
  if (root) root.replaceChildren();
}

/** True when the browser can hand this file to the device's share menu (phones, Windows, ChromeOS). */
function canShareFile(file: File): boolean {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/**
 * Receipt preview with a paper-size picker, Print (browser dialog → printer or
 * "Save as PDF") and Share PDF: a phone-size PDF handed to the share menu, where
 * WhatsApp is picked, or downloaded where there is no share menu. Reprints use
 * the stored bill, so the same cheesy line and prices appear every time.
 * The bill is already saved when this opens (justSaved says so on screen); once the
 * PDF is shared or downloaded the window closes by itself, ready for the next bill.
 */
export async function showReceipt(bill: Bill, opts: { autoPrint?: boolean; justSaved?: boolean } = {}): Promise<void> {
  const s = await getSettings();
  let width: ReceiptWidth = s.receiptWidth;

  const preview = h('div', { class: 'receipt-preview', attrs: { tabindex: 0, role: 'region', 'aria-label': 'Receipt preview' } });
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
  const share = h('button', { class: 'btn btn-wa', attrs: { type: 'button' } }, icon('share', 18), 'Share PDF');
  const done = h('button', { class: 'btn', text: 'Done', attrs: { type: 'button' } });
  const hasShareMenu = canShareFile(new File(['%PDF'], 'receipt.pdf', { type: 'application/pdf' }));
  const note = h('p', {
    class: 'field-hint',
    attrs: { role: 'status' },
    text: hasShareMenu
      ? 'Share PDF sends this receipt as a phone-size PDF. Pick WhatsApp in the share menu.'
      : 'Share PDF downloads this receipt as a phone-size PDF to attach in WhatsApp.',
  });

  const savedText = bill.sync
    ? `✓ Saved on this phone as ${bill.billNo}. It uploads by itself when the internet is back.`
    : `✓ Saved as ${bill.billNo}. Nothing more to save: share, print, or tap Done for the next bill.`;
  const body = h('div', { class: 'receipt-modal' },
    opts.justSaved ? h('p', { class: 'field-hint receipt-saved', attrs: { role: 'status' }, text: savedText }) : null,
    h('div', { class: 'receipt-toolbar' }, h('span', { class: 'field-label', text: 'Paper' }), format.el),
    preview,
    note,
  );
  const m = openModal({ title: `Receipt ${bill.billNo}`, body, actions: [done, share, print], wide: true, onClose: clearPrint });
  done.addEventListener('click', m.close);
  print.addEventListener('click', () => void printWhenReady());

  // The PDF is made in the background once the dialog is up: browsers only open the
  // share menu within a moment of the tap, so it should be ready before the tap.
  let pdf: File | undefined;
  let job: Promise<File> | undefined;
  const makePdf = (): Promise<File> =>
    (job ??= receiptPdfFile(bill, s).then(
      (file) => (pdf = file),
      (err: unknown) => {
        job = undefined; // let the next tap try again
        throw err;
      },
    ));

  const sharePdf = async () => {
    share.disabled = true;
    try {
      const file = pdf ?? (await makePdf());
      if (canShareFile(file)) {
        await navigator.share({ files: [file], title: `Receipt ${bill.billNo}` });
        m.close();
        toast(`${bill.billNo} is saved and shared`, 'success');
      } else {
        downloadBlob(file, file.name);
        m.close();
        toast(`${bill.billNo} is saved. ${file.name} is in Downloads: attach it in WhatsApp.`, 'success', 6000);
      }
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError') note.textContent = 'Tap Share PDF again to open the share menu.';
      else if (name !== 'AbortError') note.textContent = 'Could not make the PDF. Please try again.'; // AbortError: share menu closed
    } finally {
      share.disabled = false;
    }
  };
  share.addEventListener('click', () => void sharePdf());

  render();
  print.focus();
  if (opts.autoPrint) requestAnimationFrame(() => void printWhenReady());
  setTimeout(() => {
    if (m.dialog.open) void makePdf().catch(() => undefined);
  }, 300);
}
