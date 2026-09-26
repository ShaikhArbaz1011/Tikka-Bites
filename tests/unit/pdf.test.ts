import { describe, it, expect } from 'vitest';
import { buildImagePdf, jpegInfo, pdfDate, pdfText, PdfError } from '../../src/core/pdf';

/** The smallest JPEG header the writer reads: start, JFIF segment, frame header (size + channels), end. */
const tinyJpeg = (w = 3, h = 2, channels = 3) =>
  new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 8 + 3 * channels, 0x08, h >> 8, h & 255, w >> 8, w & 255, channels,
    ...Array.from({ length: channels }, (_, i) => [i + 1, 0x11, 0x00]).flat(),
    0xff, 0xd9,
  ]);
const latin1 = (b: Uint8Array) => Array.from(b, (x) => String.fromCharCode(x)).join('');

describe('jpegInfo', () => {
  it('reads size and colour channels from the frame header', () => {
    expect(jpegInfo(tinyJpeg(1080, 2340))).toEqual({ width: 1080, height: 2340, components: 3 });
    expect(jpegInfo(tinyJpeg(5, 7, 1))).toEqual({ width: 5, height: 7, components: 1 });
  });
  it('rejects things that are not usable JPEGs', () => {
    expect(() => jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toThrow(PdfError); // a PNG
    expect(() => jpegInfo(tinyJpeg().subarray(0, 24))).toThrow(PdfError); // cut short
    expect(() => jpegInfo(tinyJpeg(3, 2, 4))).toThrow(/greyscale or RGB/); // CMYK
    expect(() => jpegInfo(tinyJpeg(0, 2))).toThrow(PdfError); // no size
  });
});

describe('buildImagePdf', () => {
  const jpeg = tinyJpeg(1080, 2340);
  const created = new Date(2026, 8, 27, 0, 17, 5);
  const pdf = buildImagePdf([{ widthPt: 360, heightPt: 780, jpeg }, { widthPt: 360, heightPt: 780, jpeg }], { title: 'Receipt ₹', author: 'Tikka Bites', created });
  const text = latin1(pdf);

  it('has one phone-size page per image', () => {
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text).toContain('/Type /Pages /Kids [4 0 R 7 0 R] /Count 2');
    expect(text.match(/\/MediaBox \[0 0 360 780\]/g)).toHaveLength(2);
    expect(text.match(/\/Width 1080 \/Height 2340 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/DCTDecode/g)).toHaveLength(2);
    expect(text.endsWith('%%EOF\n')).toBe(true);
  });

  it('has a cross-reference table with exact byte offsets', () => {
    const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
    const table = text.slice(start).split('\n');
    expect(table[0]).toBe('xref');
    const count = Number(/^0 (\d+)$/.exec(table[1]!)![1]);
    expect(table[2]).toBe('0000000000 65535 f ');
    for (let n = 1; n < count; n++) {
      const entry = table[2 + n]!;
      expect(entry).toMatch(/^\d{10} 00000 n $/);
      expect(text.startsWith(`${n} 0 obj\n`, Number(entry.slice(0, 10)))).toBe(true);
    }
    expect(text).toContain(`/Size ${count} /Root 1 0 R /Info 3 0 R`);
  });

  it('embeds each image byte for byte, with the right stream length', () => {
    const head = `/Length ${jpeg.length} >>\nstream\n`;
    const at = text.indexOf(head) + head.length;
    expect(at).toBeGreaterThan(head.length);
    expect(Array.from(pdf.subarray(at, at + jpeg.length))).toEqual(Array.from(jpeg));
    expect(text.slice(at + jpeg.length, at + jpeg.length + 11)).toBe('\nendstream\n');
  });

  it('writes the title in Unicode and the date in local time (IST)', () => {
    expect(pdfText('A₹')).toBe('<FEFF004120B9>');
    expect(text).toContain(`/Title ${pdfText('Receipt ₹')}`);
    expect(pdfDate(created)).toBe("D:20260927001705+05'30'");
    expect(text).toContain("/CreationDate (D:20260927001705+05'30')");
  });

  it('refuses empty documents and impossible page sizes', () => {
    expect(() => buildImagePdf([], { title: 'x' })).toThrow(PdfError);
    expect(() => buildImagePdf([{ widthPt: 0, heightPt: 780, jpeg }], { title: 'x' })).toThrow(PdfError);
    expect(() => buildImagePdf([{ widthPt: 360, heightPt: Number.NaN, jpeg }], { title: 'x' })).toThrow(PdfError);
  });
});
