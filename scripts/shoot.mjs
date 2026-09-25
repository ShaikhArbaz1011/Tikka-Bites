// UI check: screenshots at 375px and 1280px + console error capture.
// Usage: node scripts/shoot.mjs [baseUrl] [route ...]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5173';
const routes = process.argv.slice(3).length ? process.argv.slice(3) : ['billing', 'menu', 'reports', 'settings'];
const widths = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 800 },
];
mkdirSync('screenshots', { recursive: true });

const browser = await chromium.launch();
let errors = 0;
for (const vp of widths) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') { errors++; console.log(`[${vp.name}] console.${m.type()}: ${m.text()}`); } });
  page.on('pageerror', (e) => { errors++; console.log(`[${vp.name}] pageerror: ${e.message}`); });
  for (const r of routes) {
    const [route, action] = r.split(':');
    await page.goto(`${base}/#/${route}`);
    await page.waitForLoadState('networkidle');
    if (action) await page.evaluate(action);
    await page.waitForTimeout(300);
    const file = `screenshots/${route}${action ? '-x' : ''}-${vp.name}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log(`saved ${file}`);
  }
  await ctx.close();
}
await browser.close();
console.log(errors ? `\n${errors} console problem(s)` : '\nNo console errors.');
