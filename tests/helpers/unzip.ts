// Test helper: read a ZIP (e.g. an .xlsx) using only Node's zlib, verifying every CRC.
import { inflateRawSync, crc32 } from 'node:zlib';

export function unzip(buf: Uint8Array): Map<string, string> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = buf.length - 22;
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map<string, string>();
  const dec = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory');
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (dv.getUint32(local, true) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const body = buf.subarray(start, start + compSize);
    const raw = method === 8 ? new Uint8Array(inflateRawSync(body)) : method === 0 ? body : null;
    if (!raw) throw new Error(`unsupported method ${method}`);
    if (raw.length !== size) throw new Error(`size mismatch for ${name}`);
    if (crc32(raw) !== crc) throw new Error(`CRC mismatch for ${name}`);
    files.set(name, dec.decode(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** Read typed cell values from worksheet XML: { A2: '…', B2: 46053 } */
export function cells(sheetXml: string): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const m of sheetXml.matchAll(/<c r="([A-Z]+\d+)"([^>]*)>(.*?)<\/c>/g)) {
    const [, ref, attrs, inner] = m;
    if (attrs!.includes('t="inlineStr"')) {
      out[ref!] = (/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner!)?.[1] ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    } else out[ref!] = Number(/<v>(.*?)<\/v>/.exec(inner!)?.[1]);
  }
  return out;
}
