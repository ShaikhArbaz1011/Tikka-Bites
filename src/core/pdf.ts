/**
 * Minimal PDF writer — no library (like core/xlsx.ts). Every page is one
 * full-page JPEG: the receipt is drawn on a canvas first, so the phone's own
 * fonts render ₹, emoji and any language exactly as on screen (the 14 fonts
 * built into every PDF reader can't show those).
 *
 * The file follows the PDF spec (ISO 32000, a PDF 1.4 subset): a header,
 * numbered objects, a cross-reference table of exact byte offsets, a trailer.
 */

export class PdfError extends Error {}

export interface JpegInfo {
  width: number;
  height: number;
  /** 1 = greyscale, 3 = colour. */
  components: 1 | 3;
}

/** Read a JPEG's pixel size and colour channels from its frame header (this also proves it is a JPEG). */
export function jpegInfo(b: Uint8Array): JpegInfo {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new PdfError('Not a JPEG image');
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) throw new PdfError('Damaged JPEG image');
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2; // markers without a length field
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // image ended / pixel data started before any frame header
    const length = (b[i + 2]! << 8) | b[i + 3]!;
    if (length < 2) throw new PdfError('Damaged JPEG image');
    // Frame headers are C0–CF, except C4 (Huffman tables), C8 (reserved) and CC (arithmetic coding).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 >= b.length) break;
      const height = (b[i + 5]! << 8) | b[i + 6]!;
      const width = (b[i + 7]! << 8) | b[i + 8]!;
      const components = b[i + 9]!;
      if (!width || !height) throw new PdfError('JPEG image has no size');
      if (components !== 1 && components !== 3) throw new PdfError('Only greyscale or RGB JPEG images are supported');
      return { width, height, components };
    }
    i += 2 + length;
  }
  throw new PdfError('Damaged JPEG image');
}

export interface PdfPage {
  /** Page size in points (1/72 inch). */
  widthPt: number;
  heightPt: number;
  /** JPEG that fills the whole page. */
  jpeg: Uint8Array;
}

export interface PdfMeta {
  title: string;
  author?: string;
  subject?: string;
  creator?: string;
  created?: Date;
}

/** A PDF text string that can hold any language: UTF-16BE with a byte-order mark, in hex. */
export function pdfText(s: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return `<${hex}>`;
}

/** PDF date in local time with its UTC offset, e.g. D:20260927001705+05'30'. */
export function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const abs = Math.abs(offset);
  const zone = `${offset < 0 ? '-' : '+'}${p(Math.floor(abs / 60))}'${p(abs % 60)}'`;
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${zone}`;
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
}

function ascii(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7e) throw new PdfError('PDF structure must be plain ASCII');
    b[i] = c;
  }
  return b;
}

/** Collects output and tracks the byte offset, which the cross-reference table needs. */
class Out {
  private parts: Uint8Array[] = [];
  length = 0;
  bytes(b: Uint8Array): void {
    this.parts.push(b);
    this.length += b.length;
  }
  text(s: string): void {
    this.bytes(ascii(s));
  }
  join(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Build a PDF in which every page is one full-page JPEG. Returns the file's bytes. */
export function buildImagePdf(pages: PdfPage[], meta: PdfMeta): Uint8Array {
  if (!pages.length) throw new PdfError('A PDF needs at least one page');
  for (const p of pages) {
    if (!(p.widthPt >= 3 && p.widthPt <= 14_400 && p.heightPt >= 3 && p.heightPt <= 14_400)) {
      throw new PdfError('Page size must be 3–14400 points');
    }
  }
  const out = new Out();
  const offsets: number[] = [];
  const obj = (n: number, body: string) => {
    offsets[n] = out.length;
    out.text(`${n} 0 obj\n${body}\nendobj\n`);
  };
  const stream = (n: number, dict: string, data: Uint8Array) => {
    offsets[n] = out.length;
    out.text(`${n} 0 obj\n<< ${dict}/Length ${data.length} >>\nstream\n`);
    out.bytes(data);
    out.text('\nendstream\nendobj\n');
  };

  out.text('%PDF-1.4\n');
  out.bytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // "%âãÏÓ": tells tools the file is binary

  // Objects: 1 catalog, 2 page list, 3 document info, then 3 per page (page, drawing, image).
  const pageId = (i: number) => 4 + i * 3;
  obj(1, '<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /DisplayDocTitle true >> >>');
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  const date = pdfDate(meta.created ?? new Date());
  const info = [`/Title ${pdfText(meta.title)}`];
  if (meta.author) info.push(`/Author ${pdfText(meta.author)}`);
  if (meta.subject) info.push(`/Subject ${pdfText(meta.subject)}`);
  if (meta.creator) info.push(`/Creator ${pdfText(meta.creator)}`);
  info.push(`/CreationDate (${date}) /ModDate (${date})`);
  obj(3, `<< ${info.join(' ')} >>`);

  pages.forEach((p, i) => {
    const img = jpegInfo(p.jpeg);
    const w = num(p.widthPt);
    const h = num(p.heightPt);
    const id = pageId(i);
    obj(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> /ProcSet [/PDF /ImageC /ImageB] >> /Contents ${id + 1} 0 R >>`);
    stream(id + 1, '', ascii(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`)); // stretch the image over the whole page
    const colour = img.components === 1 ? 'DeviceGray' : 'DeviceRGB';
    stream(id + 2, `/Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /${colour} /BitsPerComponent 8 /Filter /DCTDecode `, p.jpeg);
  });

  const size = pageId(pages.length);
  const xref = out.length;
  const rows = ['xref', `0 ${size}`, '0000000000 65535 f '];
  for (let n = 1; n < size; n++) rows.push(`${String(offsets[n]).padStart(10, '0')} 00000 n `);
  const id = randomHex(16);
  out.text(`${rows.join('\n')}\ntrailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xref}\n%%EOF\n`);
  return out.join();
}
