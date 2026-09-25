import { describe, it, expect } from 'vitest';
import { sniffImageType, fitWithin } from '../../src/core/image';

const bytes = (...xs: number[]) => new Uint8Array(xs);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

describe('sniffImageType', () => {
  it('detects PNG, JPEG and WEBP by magic bytes', () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('png');
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(sniffImageType(bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')))).toBe('webp');
  });
  it('rejects everything else, e.g. SVG or HTML renamed to .png', () => {
    expect(sniffImageType(bytes(...ascii('<svg xmlns='))) ).toBeNull();
    expect(sniffImageType(bytes(...ascii('<html><scr')))).toBeNull();
    expect(sniffImageType(bytes(...ascii('GIF89a')))).toBeNull();
    expect(sniffImageType(bytes())).toBeNull();
  });
});

describe('fitWithin', () => {
  it('keeps small images as-is and scales large ones to 300px max side', () => {
    expect(fitWithin(200, 100)).toEqual({ w: 200, h: 100 });
    expect(fitWithin(1200, 600)).toEqual({ w: 300, h: 150 });
    expect(fitWithin(500, 2000)).toEqual({ w: 75, h: 300 });
    expect(fitWithin(5000, 1)).toEqual({ w: 300, h: 1 });
  });
});
