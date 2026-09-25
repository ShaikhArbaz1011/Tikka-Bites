// Serve dist/ with the SAME headers and SPA fallback as vercel.json, so local
// tests exercise the real Content-Security-Policy.
// Usage: node scripts/serve-dist.mjs [port] [--pages /repo/]
//   --pages /repo/  imitate GitHub Pages: serve under a sub-folder, send no custom headers.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const port = Number(process.argv[2] ?? 4173);
const pagesAt = process.argv.indexOf('--pages');
const prefix = pagesAt > 0 ? process.argv[pagesAt + 1] ?? '/app/' : '/';
const root = 'dist';
const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
const TYPES = {
  '.webp': 'image/webp',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

function headersFor(path) {
  const out = {};
  for (const rule of vercel.headers) {
    const re = new RegExp('^' + rule.source.replace(/\(\.\*\)/g, '.*') + '$');
    if (re.test(path)) for (const { key, value } of rule.headers) out[key] = value;
  }
  return out;
}

createServer((req, res) => {
  const full = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (!full.startsWith(prefix)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const path = '/' + full.slice(prefix.length);
  let file = normalize(join(root, path));
  if (!file.startsWith(normalize(root))) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html'); // SPA fallback
  const body = readFileSync(file);
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', ...(pagesAt > 0 ? {} : headersFor(path)) });
  res.end(body);
}).listen(port, () => console.log(`dist served on http://localhost:${port}${prefix}`));
