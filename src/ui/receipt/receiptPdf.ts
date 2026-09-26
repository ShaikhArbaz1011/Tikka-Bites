/**
 * Receipt → PDF shaped like a portrait phone screen (360 × 780 pt, about 19.5:9),
 * for sending on WhatsApp. The receipt is drawn on a canvas with the device's own
 * fonts, so ₹, emoji and any language look exactly like the on-screen receipt,
 * then wrapped in a PDF by core/pdf.ts. Long bills continue on more pages of the
 * same size, and an item row is never split between pages.
 */
import { buildImagePdf, type PdfPage } from '../../core/pdf';
import { formatINR } from '../../core/money';
import { formatDateTime } from '../../core/dates';
import { assetUrl } from '../../assets';
import { BUILT_IN_LOGO } from '../../db/db';
import { PAYMENT_LABEL, discountLabel, orderLine, roundOffText } from './receipt';
import type { Bill, Settings } from '../../db/types';

/** Page size in points (1/72 inch): the proportions of a portrait phone screen. */
export const PDF_PAGE = { width: 360, height: 780 } as const;
/** Where content starts on every page. */
export const CONTENT_TOP = 28;
/** Lowest point content may reach; the page number sits below it. */
export const CONTENT_BOTTOM = PDF_PAGE.height - 34;
/** Canvas pixels per point: 1080 × 2340 px per page, as sharp as a phone screen. */
const SCALE = 3;
const JPEG_QUALITY = 0.92;
const MX = 22; // side margin
const W = PDF_PAGE.width - 2 * MX; // content width
const CX = PDF_PAGE.width / 2;
const GAP = 10; // between table columns
const LOGO = 76;
/** Same stack as --font in styles/tokens.css. */
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Helvetica Neue', Arial, sans-serif";

interface Style {
  font: string;
  /** Line height in points. */
  lh: number;
}
const T = {
  body: { font: `400 12px ${FONT}`, lh: 16 },
  bold: { font: `700 12px ${FONT}`, lh: 16 },
  small: { font: `400 10.5px ${FONT}`, lh: 14 },
  name: { font: `800 20px ${FONT}`, lh: 25 },
  total: { font: `800 16px ${FONT}`, lh: 22 },
  cheesy: { font: `italic 600 12px ${FONT}`, lh: 16 },
  note: { font: `400 9px ${FONT}`, lh: 12 },
};

type Ctx = CanvasRenderingContext2D;

export interface Block {
  height: number;
  draw(ctx: Ctx, top: number): void;
  /** An item row: a page that starts with one repeats the table header. */
  item?: boolean;
  /** Keep on the same page as the next block (the table header). */
  keepWithNext?: boolean;
}

export interface Placed {
  block: Block;
  top: number;
}

/**
 * Lay blocks out on phone-size pages. A block that doesn't fit starts a new page,
 * which opens with a "continued" line (plus the table header if items continue).
 */
export function paginate(blocks: Block[], tableHead: Block, continued: Block): Placed[][] {
  const sheets: Placed[][] = [[]];
  let y = CONTENT_TOP;
  const place = (block: Block) => {
    sheets[sheets.length - 1]!.push({ block, top: y });
    y += block.height;
  };
  blocks.forEach((b, i) => {
    const next = blocks[i + 1];
    const need = b.height + (b.keepWithNext && next ? next.height : 0);
    if (y + need > CONTENT_BOTTOM && sheets[sheets.length - 1]!.length > 0) {
      sheets.push([]);
      y = CONTENT_TOP;
      place(continued);
      if (b.item) place(tableHead);
    }
    place(b);
  });
  return sheets;
}

/** File name WhatsApp shows in the chat, e.g. TikkaBites-RCPT-202609-0042.pdf. */
export function receiptFileName(bill: Bill, s: Settings): string {
  const shop = s.name.normalize('NFKD').replace(/[^A-Za-z0-9]/g, '').slice(0, 30);
  return `${shop || 'Receipt'}-${bill.billNo}.pdf`;
}

function write(ctx: Ctx, text: string, x: number, lineTop: number, st: Style, align: CanvasTextAlign, color: string): void {
  ctx.font = st.font;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, x, lineTop + st.lh / 2);
}

function measure(ctx: Ctx, text: string, st: Style): number {
  ctx.font = st.font;
  return ctx.measureText(text).width;
}

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const letters = (s: string): string[] => (segmenter ? Array.from(segmenter.segment(s), (g) => g.segment) : Array.from(s));

/** Word-wrap to `width`, keeping the text's own line breaks; a word longer than a line breaks between letters. */
function wrap(ctx: Ctx, text: string, width: number, st: Style): string[] {
  ctx.font = st.font;
  const fits = (s: string) => ctx.measureText(s).width <= width;
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const joined = line ? `${line} ${word}` : word;
      if (fits(joined)) {
        line = joined;
        continue;
      }
      if (line) out.push(line);
      line = '';
      if (fits(word)) {
        line = word;
        continue;
      }
      for (const g of letters(word)) {
        if (line && !fits(line + g)) {
          out.push(line);
          line = g;
        } else line += g;
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [''];
}

/**
 * Moves down the page. Each block's painting code runs twice: once to measure
 * (live = false), once to draw, so a block's height always matches what it draws.
 */
class Pen {
  y: number;
  private readonly ctx: Ctx;
  private readonly live: boolean;
  constructor(ctx: Ctx, top: number, live: boolean) {
    this.ctx = ctx;
    this.y = top;
    this.live = live;
  }
  gap(pt: number): void {
    this.y += pt;
  }
  /** Text on the current line, staying on it (for more columns). */
  put(text: string, x: number, st: Style, align: CanvasTextAlign = 'left', color = '#000'): void {
    if (this.live) write(this.ctx, text, x, this.y, st, align, color);
  }
  /** Text on the current line, then down one line. */
  line(text: string, x: number, st: Style, align: CanvasTextAlign = 'left', color = '#000'): void {
    this.put(text, x, st, align, color);
    this.y += st.lh;
  }
  rule(dashed: boolean, weight = 0.8): void {
    if (!this.live) return;
    const c = this.ctx;
    c.save();
    c.strokeStyle = '#000';
    c.lineWidth = weight;
    c.setLineDash(dashed ? [3, 2] : []);
    c.beginPath();
    c.moveTo(MX, this.y);
    c.lineTo(MX + W, this.y);
    c.stroke();
    c.restore();
  }
  art(paint: (ctx: Ctx, top: number) => void): void {
    if (this.live) paint(this.ctx, this.y);
  }
}

type BlockOptions = Pick<Block, 'item' | 'keepWithNext'>;

function blockOf(ctx: Ctx, paint: (pen: Pen) => void, extra: BlockOptions = {}): Block {
  const probe = new Pen(ctx, 0, false);
  paint(probe);
  return { ...extra, height: probe.y, draw: (c, top) => paint(new Pen(c, top, true)) };
}

/** The logo as a circle, from a centred square crop (like object-fit: cover). */
function drawLogo(ctx: Ctx, img: HTMLImageElement, top: number): void {
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) return;
  const r = LOGO / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(CX, top + r, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, CX - r, top, LOGO, LOGO);
  ctx.restore();
}

/** Item-table columns: numbers take the width of their widest value; the dish name gets the rest. */
function columns(ctx: Ctx, bill: Bill, m: (p: number) => string) {
  const widest = (texts: string[], label: string) => Math.max(measure(ctx, label, T.bold), ...texts.map((t) => measure(ctx, t, T.body)));
  const amtW = widest(bill.items.map((i) => m(i.linePaise)), 'Amount');
  const rateW = widest(bill.items.map((i) => m(i.unitPaise)), 'Rate');
  const qtyW = widest(bill.items.map((i) => String(i.qty)), 'Qty');
  const amtR = MX + W;
  const withRate = W - amtW - rateW - qtyW - 3 * GAP;
  // Very large amounts: drop the Rate column (as on 58 mm paper) so dish names stay readable.
  const itemW = withRate >= 110 ? withRate : W - amtW - qtyW - 2 * GAP;
  const rateR = withRate >= 110 ? amtR - amtW - GAP : null;
  return { itemW, qtyC: MX + itemW + GAP + qtyW / 2, rateR, amtR };
}

/** Every block of the receipt in order, plus the two blocks later pages open with. */
function layout(ctx: Ctx, bill: Bill, s: Settings, logo: HTMLImageElement | null): { blocks: Block[]; tableHead: Block; continued: Block } {
  const m = (p: number) => formatINR(p, s.currencySymbol);
  const block = (paint: (pen: Pen) => void, extra: BlockOptions = {}) => blockOf(ctx, paint, extra);
  const blocks: Block[] = [];

  // Shop header, as on the printed receipt.
  const img = logo;
  const name = wrap(ctx, s.name, W, T.name);
  const contact = [...(s.address ? wrap(ctx, s.address, W, T.small) : []), ...(s.phone ? wrap(ctx, `Ph: ${s.phone}`, W, T.small) : [])];
  blocks.push(
    block((p) => {
      if (img) {
        p.art((c, top) => drawLogo(c, img, top));
        p.gap(LOGO + 8);
      }
      for (const l of name) p.line(l, CX, T.name, 'center');
      p.gap(2);
      for (const l of contact) p.line(l, CX, T.small, 'center');
      p.gap(7);
      p.rule(true);
      p.gap(7);
    }),
  );

  if (bill.status === 'void') {
    const lines = wrap(ctx, `VOID — ${bill.voidReason ?? ''}`, W - 16, T.bold);
    blocks.push(
      block((p) => {
        p.art((c, top) => {
          c.save();
          c.lineWidth = 2;
          c.strokeStyle = '#000';
          c.strokeRect(MX + 1, top + 1, W - 2, lines.length * T.bold.lh + 10);
          c.restore();
        });
        p.gap(6);
        for (const l of lines) p.line(l, CX, T.bold, 'center');
        p.gap(14);
      }),
    );
  }

  const meta: [string, string][] = [
    ['Receipt No', bill.billNo],
    ['Date', formatDateTime(bill.createdAt)],
    ['Order', orderLine(bill)],
  ];
  if (bill.customerName) meta.push(['Customer', bill.customerName]);
  const labelW = Math.max(...meta.map(([label]) => measure(ctx, label, T.body)));
  const metaRows = meta.map(([label, value]) => ({ label, lines: wrap(ctx, value, W - labelW - GAP, T.body) }));
  blocks.push(
    block((p) => {
      for (const { label, lines } of metaRows) {
        p.put(label, MX, T.body);
        for (const l of lines) p.line(l, MX + W, T.body, 'right');
      }
      p.gap(7);
      p.rule(true);
      p.gap(7);
    }),
  );

  const col = columns(ctx, bill, m);
  const tableHead = block(
    (p) => {
      p.put('Item', MX, T.bold);
      p.put('Qty', col.qtyC, T.bold, 'center');
      if (col.rateR !== null) p.put('Rate', col.rateR, T.bold, 'right');
      p.line('Amount', col.amtR, T.bold, 'right');
      p.gap(2);
      p.rule(false);
      p.gap(3);
    },
    { keepWithNext: true },
  );
  blocks.push(tableHead);
  for (const it of bill.items) {
    const lines = wrap(ctx, it.name, col.itemW, T.body);
    blocks.push(
      block(
        (p) => {
          p.gap(3);
          p.put(String(it.qty), col.qtyC, T.body, 'center');
          if (col.rateR !== null) p.put(m(it.unitPaise), col.rateR, T.body, 'right');
          p.put(m(it.linePaise), col.amtR, T.body, 'right');
          for (const l of lines) p.line(l, MX, T.body);
          p.gap(3);
        },
        { item: true },
      ),
    );
  }

  const sums: [string, string][] = [[`Subtotal (${bill.itemCount} item${bill.itemCount === 1 ? '' : 's'})`, m(bill.subtotalPaise)]];
  if (bill.discountPaise) sums.push([discountLabel(bill), `−${m(bill.discountPaise)}`]);
  if (bill.roundOffPaise) sums.push(['Round off', roundOffText(bill.roundOffPaise, m)]);
  blocks.push(
    block((p) => {
      p.gap(4);
      p.rule(true);
      p.gap(7);
      for (const [label, value] of sums) {
        p.put(label, MX, T.body);
        p.line(value, MX + W, T.body, 'right');
      }
      p.gap(4);
      p.rule(false, 1);
      p.gap(5);
      p.put('TOTAL', MX, T.total);
      p.line(m(bill.totalPaise), MX + W, T.total, 'right');
      p.gap(5);
      p.rule(false, 1);
      p.gap(6);
      p.put('Paid by', MX, T.body);
      p.line(PAYMENT_LABEL[bill.paymentMode], MX + W, T.body, 'right');
      p.gap(7);
    }),
  );

  const cheesy = bill.cheesyLine ? wrap(ctx, bill.cheesyLine, W, T.cheesy) : [];
  blocks.push(
    block((p) => {
      p.rule(true);
      p.gap(9);
      for (const l of cheesy) p.line(l, CX, T.cheesy, 'center');
      p.gap(2);
      p.line('Thank you! Visit again.', CX, T.small, 'center');
    }),
  );

  const continued = block((p) => {
    p.line(`Receipt ${bill.billNo}, continued`, MX, T.small, 'left', '#444');
    p.gap(8);
  });
  return { blocks, tableHead, continued };
}

async function loadImage(src: string): Promise<HTMLImageElement | null> {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
    return img;
  } catch {
    return null; // a receipt without the logo beats no receipt
  }
}

async function toJpeg(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  if (!blob) throw new Error('Could not draw the receipt');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Draw the receipt on phone-size pages and return the PDF's bytes. Browser only. */
export async function receiptPdf(bill: Bill, s: Settings): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = PDF_PAGE.width * SCALE;
  canvas.height = PDF_PAGE.height * SCALE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not draw the receipt');
  const logo = s.printLogo !== false ? await loadImage(s.logoDataUrl ?? assetUrl(BUILT_IN_LOGO)) : null;
  const { blocks, tableHead, continued } = layout(ctx, bill, s, logo);
  const sheets = paginate(blocks, tableHead, continued);
  const pages: PdfPage[] = [];
  for (const [i, sheet] of sheets.entries()) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    for (const { block, top } of sheet) block.draw(ctx, top);
    if (sheets.length > 1) write(ctx, `Page ${i + 1} of ${sheets.length}`, CX, CONTENT_BOTTOM + 12, T.note, 'center', '#444');
    pages.push({ widthPt: PDF_PAGE.width, heightPt: PDF_PAGE.height, jpeg: await toJpeg(canvas) });
  }
  return buildImagePdf(pages, { title: `${s.name} receipt ${bill.billNo}`, author: s.name, creator: 'Tikka Bites billing app' });
}

/** The receipt PDF as a File, ready for the share menu or a download. */
export async function receiptPdfFile(bill: Bill, s: Settings): Promise<File> {
  return new File([(await receiptPdf(bill, s)) as BlobPart], receiptFileName(bill, s), { type: 'application/pdf' });
}
