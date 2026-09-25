import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { TIKKA_BITES_MENU } from '../../src/data/sampleMenu';
import { isDishImage, LIMITS } from '../../src/core/validate';
import { MAX_PRICE_PAISE } from '../../src/core/money';
import { DEFAULT_SETTINGS, BUILT_IN_LOGO } from '../../src/db/db';

describe('Tikka Bites menu data', () => {
  it('has 40 valid dishes across the 8 menu sections', () => {
    expect(TIKKA_BITES_MENU).toHaveLength(40);
    expect(new Set(TIKKA_BITES_MENU.map((d) => d.category)).size).toBe(8);
    for (const d of TIKKA_BITES_MENU) {
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.name.length).toBeLessThanOrEqual(LIMITS.dishName);
      expect(d.category.length).toBeLessThanOrEqual(LIMITS.category);
      expect(Number.isSafeInteger(d.pricePaise) && d.pricePaise > 0 && d.pricePaise <= MAX_PRICE_PAISE).toBe(true);
    }
    expect(new Set(TIKKA_BITES_MENU.map((d) => d.name)).size).toBe(40); // no duplicate names
  });
  it('matches menu-card prices', () => {
    const price = (n: string) => TIKKA_BITES_MENU.find((d) => d.name === n)!.pricePaise / 100;
    expect(price('Full Chicken')).toBe(450);
    expect(price('Chicken Tikka Wrap with Cheese')).toBe(170);
    expect(price('Chicken Popcorn (24 Pcs)')).toBe(200);
    expect(price('Chili Cheese Fries – Full')).toBe(100);
    expect(price('Water Bottle (500 ml)')).toBe(10);
  });
  it('every dish photo is valid and exists in public/', () => {
    for (const d of TIKKA_BITES_MENU) {
      expect(isDishImage(d.image)).toBe(true);
      expect(existsSync(`public${d.image}`)).toBe(true);
    }
  });
  it('fries, crème and drinks are veg; grill, wraps, burgers, sandwiches and nuggets are non-veg', () => {
    const vegSections = new Set(['Aloo Ke Laloo', 'Mitthu Miya (Seasonal)', 'Thanda Matter']);
    for (const d of TIKKA_BITES_MENU) expect(d.isVeg).toBe(vegSections.has(d.category));
  });
});

describe('dish image validation', () => {
  it.each(['/dishes/tikka-wrap.webp', 'data:image/webp;base64,UklGRg=='])('accepts %s', (v) => expect(isDishImage(v)).toBe(true));
  it.each([
    'javascript:alert(1)',
    'https://evil.example/x.webp',
    '/dishes/../../secret.webp',
    '/dishes/x.svg',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:text/html;base64,PHNjcmlwdD4=',
    `data:image/png;base64,${'A'.repeat(200_001)}`,
    42,
  ])('rejects %s', (v) => expect(isDishImage(v)).toBe(false));
});

describe('brand defaults', () => {
  it('uses Tikka Bites details and the built-in round logo', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ name: 'Tikka Bites', phone: '9137582060', printLogo: true });
    expect(existsSync(`public${BUILT_IN_LOGO}`)).toBe(true);
  });
});
