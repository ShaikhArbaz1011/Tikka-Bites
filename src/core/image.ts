/** Logo upload helpers: type sniffing from the file's first bytes, and resize. */

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const LOGO_MAX_SIDE = 300;
const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];

export type ImageKind = 'png' | 'jpeg' | 'webp';

/** Identify PNG / JPEG / WEBP by magic bytes, ignoring the (spoofable) file name. */
export function sniffImageType(b: Uint8Array): ImageKind | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'webp';
  return null;
}

/** Scale (w, h) down so the longest side is at most `max`, keeping aspect ratio. */
export function fitWithin(w: number, h: number, max = LOGO_MAX_SIDE): { w: number; h: number } {
  if (w <= max && h <= max) return { w, h };
  const k = max / Math.max(w, h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

export class LogoError extends Error {}

/** Validate an uploaded file and return a compressed data URL (≤ 300px). Browser only. */
export async function logoToDataUrl(file: File): Promise<string> {
  if (!ALLOWED_MIME.includes(file.type)) throw new LogoError('Please choose a PNG, JPG or WEBP image');
  if (file.size > MAX_LOGO_BYTES) throw new LogoError('Image must be 2 MB or smaller');
  const kind = sniffImageType(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  if (!kind) throw new LogoError('This file is not a real PNG, JPG or WEBP image');

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new LogoError('Could not read this image');
  }
  const { w, h } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new LogoError('Could not process this image');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  // WEBP keeps transparency and is small; fall back where unsupported (older Safari).
  let url = canvas.toDataURL('image/webp', 0.85);
  if (!url.startsWith('data:image/webp')) url = kind === 'jpeg' ? canvas.toDataURL('image/jpeg', 0.85) : canvas.toDataURL('image/png');
  return url;
}
