/**
 * Minimal Excel (.xlsx) writer — no library. An .xlsx file is a ZIP of XML parts;
 * we write the parts ourselves and zip them (deflate via CompressionStream when
 * the browser has it, otherwise stored). Cells are typed so Excel shows real
 * dates, times and ₹ amounts that sort and sum correctly. Text is written as
 * inline strings, never formulas, so cell text can't execute in Excel.
 */

export type ColType = 'text' | 'int' | 'money' | 'date' | 'time' | 'percent';

export interface Column {
  header: string;
  type: ColType;
  /** Width in characters. */
  width: number;
}

/** text: string · int/money/percent: number (money in rupees) · date/time: epoch ms (local time). */
export type Cell = string | number | null | undefined;

export interface Sheet {
  name: string;
  columns: Column[];
  rows: Cell[][];
  /** Optional title lines above the table (e.g. report period). */
  title?: string[];
}

export const MAX_ROWS = 1_048_576;

// ---------- values ----------

const DAY_MS = 86_400_000;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/** Excel serial date for the LOCAL calendar day of `ms` (no time part). */
export function excelDate(ms: number): number {
  const d = new Date(ms);
  return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - EXCEL_EPOCH) / DAY_MS;
}

/** Excel time-of-day fraction for the LOCAL clock time of `ms`. */
export function excelTime(ms: number): number {
  const d = new Date(ms);
  return (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86_400;
}

// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
// Keep valid surrogate pairs (emoji), drop lone halves. No lookbehind (older Safari).
const SURROGATES = /([\uD800-\uDBFF][\uDC00-\uDFFF])|[\uD800-\uDFFF]/g;

export function xmlEscape(s: string): string {
  return s
    .replace(INVALID_XML, '')
    .replace(SURROGATES, (_m, pair: string | undefined) => pair ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 0 → A, 25 → Z, 26 → AA … */
export function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Sheet names: ≤ 31 chars, none of []:*?/\ , unique. */
export function safeSheetName(name: string, taken: Set<string>): string {
  const base = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let n = base;
  for (let i = 2; taken.has(n.toLowerCase()); i++) n = `${base.slice(0, 27)} (${i})`;
  taken.add(n.toLowerCase());
  return n;
}

// ---------- styles ----------
// cellXfs indexes used below.
const S = { text: 0, header: 1, date: 2, time: 3, money: 4, int: 5, title: 6, percent: 7 } as const;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="dd\\-mm\\-yyyy"/><numFmt numFmtId="165" formatCode="hh:mm"/><numFmt numFmtId="166" formatCode="&quot;₹&quot;#,##0.00;\\-&quot;₹&quot;#,##0.00"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD4000A"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// ---------- sheet XML ----------

function cellXml(ref: string, v: Cell, type: ColType): string {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'text' || typeof v === 'string') {
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(v))}</t></is></c>`;
  }
  if (!Number.isFinite(v)) return '';
  let num = v;
  if (type === 'date') num = excelDate(v);
  else if (type === 'time') num = excelTime(v);
  return `<c r="${ref}" s="${S[type]}"><v>${num}</v></c>`;
}

function sheetXml(sheet: Sheet, rows: Cell[][]): string {
  const cols = sheet.columns;
  const lastCol = colName(cols.length - 1);
  const parts: string[] = [];
  let r = 0;
  for (const line of sheet.title ?? []) {
    r++;
    parts.push(`<row r="${r}"><c r="A${r}" t="inlineStr" s="${r === 1 ? S.title : S.text}"><is><t xml:space="preserve">${xmlEscape(line)}</t></is></c></row>`);
  }
  if (sheet.title?.length) r++; // blank spacer row
  const headerRow = r + 1;
  r = headerRow;
  parts.push(
    `<row r="${r}">${cols.map((c, i) => `<c r="${colName(i)}${r}" t="inlineStr" s="${S.header}"><is><t xml:space="preserve">${xmlEscape(c.header)}</t></is></c>`).join('')}</row>`,
  );
  for (const row of rows) {
    r++;
    let cells = '';
    for (let i = 0; i < cols.length; i++) cells += cellXml(`${colName(i)}${r}`, row[i], cols[i]!.type);
    parts.push(`<row r="${r}">${cells}</row>`);
  }
  const lastRow = Math.max(r, headerRow);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${lastCol}${lastRow}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('')}</cols>
<sheetData>${parts.join('')}</sheetData>
<autoFilter ref="A${headerRow}:${lastCol}${lastRow}"/>
<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>`;
}

/** Split sheets that exceed Excel's row limit into "Name (2)", "Name (3)" … */
function paginate(sheets: Sheet[]): { sheet: Sheet; rows: Cell[][]; name: string }[] {
  const taken = new Set<string>();
  const out: { sheet: Sheet; rows: Cell[][]; name: string }[] = [];
  for (const sheet of sheets) {
    const per = MAX_ROWS - 1 - (sheet.title?.length ? sheet.title.length + 1 : 0);
    for (let i = 0; i === 0 || i < sheet.rows.length; i += per) {
      out.push({ sheet, rows: sheet.rows.slice(i, i + per), name: safeSheetName(sheet.name, taken) });
    }
  }
  return out;
}

/** Build all workbook parts as { path: xml }. Exported for tests. */
export function workbookParts(sheets: Sheet[]): [path: string, content: string][] {
  const pages = paginate(sheets);
  const n = pages.length;
  const wsList = pages.map((_, i) => `xl/worksheets/sheet${i + 1}.xml`);
  return [
    [
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${wsList.map((p) => `<Override PartName="/${p}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    ],
    [
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${pages.map((p, i) => `<sheet name="${xmlEscape(p.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><definedNames>${pages
        .map((p, i) => {
          const header = p.sheet.title?.length ? p.sheet.title.length + 2 : 1;
          const last = header + p.rows.length;
          const sheetRef = `'${p.name.replace(/'/g, "''")}'`;
          return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlEscape(`${sheetRef}!$A$${header}:$${colName(p.sheet.columns.length - 1)}$${last}`)}</definedName>`;
        })
        .join('')}</definedNames></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wsList.map((p, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${p.slice(3)}"/>`).join('')}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ],
    ['xl/styles.xml', STYLES],
    ...pages.map((p, i): [string, string] => [wsList[i]!, sheetXml(p.sheet, p.rows)]),
  ];
}

// ---------- ZIP ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null; // 'deflate-raw' unsupported: store instead
  }
}

function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Build a ZIP archive (deflate when available, else store). */
export async function zip(files: [path: string, content: string][], now = Date.now()): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [path, content] of files) {
    const name = enc.encode(path);
    const raw = enc.encode(content);
    const crc = crc32(raw);
    const deflated = await deflateRaw(raw);
    const useDeflate = deflated !== null && deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, body);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, method, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, body.length, true);
    cd.setUint32(24, raw.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);

    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);

  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Build an .xlsx workbook as a Blob. */
export async function buildXlsx(sheets: Sheet[]): Promise<Blob> {
  return new Blob([(await zip(workbookParts(sheets))) as BlobPart], { type: XLSX_MIME });
}
