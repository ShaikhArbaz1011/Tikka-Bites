// Fails the build if the initial JS (entry chunk + its static imports) exceeds the gzip budget.
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const BUDGET_KB = 60;
const dist = 'dist';
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const initial = new Set(
  [...html.matchAll(/(?:src|href)="(?:\.?\/)?(assets\/[^"]+\.js)"/g)].map((m) => m[1]),
);

const kb = (file) => gzipSync(readFileSync(join(dist, file)), { level: 9 }).length / 1024;
let initialKb = 0;
const rows = [];
for (const f of readdirSync(join(dist, 'assets'))) {
  if (!f.endsWith('.js') && !f.endsWith('.css')) continue;
  const path = `assets/${f}`;
  const size = kb(path);
  const isInitial = initial.has(path);
  if (isInitial) initialKb += size;
  rows.push(`${isInitial ? '*' : ' '} ${size.toFixed(1).padStart(6)} KB  ${path}`);
}
console.log(rows.sort().join('\n'));
console.log(`\nInitial JS (gzip): ${initialKb.toFixed(1)} KB / budget ${BUDGET_KB} KB   (* = loaded on startup)`);
if (initialKb > BUDGET_KB) {
  console.error('❌ JS budget exceeded');
  process.exit(1);
}
