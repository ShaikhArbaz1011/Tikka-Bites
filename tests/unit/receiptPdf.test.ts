import { describe, it, expect } from 'vitest';
import { paginate, receiptFileName, PDF_PAGE, CONTENT_TOP, CONTENT_BOTTOM, type Block } from '../../src/ui/receipt/receiptPdf';
import type { Bill, Settings } from '../../src/db/types';

const block = (height: number, extra: Partial<Block> = {}): Block => ({ height, draw: () => undefined, ...extra });

describe('receipt PDF pages', () => {
  it('are shaped like a portrait phone screen (19.5:9)', () => {
    expect(PDF_PAGE.height / PDF_PAGE.width).toBeCloseTo(19.5 / 9, 2);
  });

  it('keep a short bill on one page', () => {
    const head = block(22, { keepWithNext: true });
    expect(paginate([block(140), block(62), head, block(22, { item: true }), block(120), block(60)], head, block(22))).toHaveLength(1);
  });

  it('continue a long bill on more pages, repeating the table header, never splitting a row', () => {
    const head = block(22, { keepWithNext: true });
    const cont = block(22);
    const items = Array.from({ length: 40 }, (_, i) => block(i % 3 ? 22 : 38, { item: true }));
    const blocks = [block(140), block(62), head, ...items, block(120), block(60)];
    const sheets = paginate(blocks, head, cont);
    expect(sheets.length).toBeGreaterThan(1);
    for (const sheet of sheets) {
      const last = sheet[sheet.length - 1]!;
      expect(last.top + last.block.height).toBeLessThanOrEqual(CONTENT_BOTTOM);
    }
    for (const sheet of sheets.slice(1)) {
      expect(sheet[0]!.block).toBe(cont);
      expect(sheet[1]!.block.item).toBeFalsy(); // items never start a page without the header
    }
    const flat = sheets.flat().map((p) => p.block).filter((b) => b !== cont);
    const firstHead = flat.indexOf(head);
    expect(flat.filter((b, i) => b !== head || i === firstHead)).toEqual(blocks); // each block once, in order
  });

  it('never leaves the table header alone at the bottom of a page', () => {
    const head = block(22, { keepWithNext: true });
    const cont = block(22);
    const filler = block(CONTENT_BOTTOM - CONTENT_TOP - 30); // 30 pt left: the header fits, header + a row doesn't
    const item = block(22, { item: true });
    const sheets = paginate([filler, head, item], head, cont);
    expect(sheets.map((s) => s.map((p) => p.block))).toEqual([[filler], [cont, head, item]]);
  });
});

describe('receipt PDF file name', () => {
  const bill = { billNo: 'RCPT-202609-0042' } as Bill;
  it.each([
    ['Tikka Bites', 'TikkaBites-RCPT-202609-0042.pdf'],
    ['Café Crème', 'CafeCreme-RCPT-202609-0042.pdf'],
    ['टिक्का', 'Receipt-RCPT-202609-0042.pdf'],
  ])('%s → %s', (name, file) => expect(receiptFileName(bill, { name } as Settings)).toBe(file));
});
