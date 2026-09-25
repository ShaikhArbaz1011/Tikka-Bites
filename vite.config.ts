import { defineConfig, type Plugin } from 'vitest/config';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Emit sw.js with the exact list of built files to precache (no Workbox needed).
 * Paths are relative to sw.js so the app works at a site root or a sub-folder.
 * The cache version is a hash of every file's CONTENT, so replacing an image
 * (same name) still rolls out to installed devices.
 */
function serviceWorker(): Plugin {
  return {
    name: 'restobill-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const publicFiles = (dir: string): string[] =>
        readdirSync(dir).flatMap((f) => {
          const p = join(dir, f);
          return statSync(p).isDirectory() ? publicFiles(p) : [relative('public', p).split(sep).join('/')];
        });
      const pub = publicFiles('public');
      const built = Object.keys(bundle).filter((f) => f !== 'index.html');
      const hash = createHash('sha256');
      for (const f of Object.keys(bundle).sort()) {
        const out = bundle[f]!;
        hash.update(f).update(out.type === 'chunk' ? out.code : out.source);
      }
      for (const f of pub.sort()) hash.update(f).update(readFileSync(join('public', f)));
      const files = ['./', 'index.html', ...built, ...pub];
      const source = readFileSync('src/sw.js', 'utf8')
        .replace('__PRECACHE__', JSON.stringify(files))
        .replace('__VERSION__', hash.digest('hex').slice(0, 10));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

/**
 * Content-Security-Policy as a <meta> tag for hosts that can't send headers
 * (GitHub Pages). Netlify/Vercel also send it as a header (netlify.toml /
 * vercel.json), which adds frame-ancestors (not allowed in <meta>).
 * Build only: the dev server injects inline styles for hot reload.
 */
const META_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; upgrade-insecure-requests";

function metaCsp(): Plugin {
  return {
    name: 'restobill-meta-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: META_CSP }, injectTo: 'head-prepend' }],
  };
}

export default defineConfig({
  // Relative base: the same build works on Netlify/Vercel (site root) and GitHub Pages (/<repo>/).
  base: './',
  plugins: [serviceWorker(), metaCsp()],
  build: {
    target: 'es2022',
    modulePreload: { polyfill: false },
    cssCodeSplit: true,
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    // The shop runs on Indian time; month boundaries are tested in IST (UTC+5:30).
    env: { TZ: 'Asia/Kolkata' },
  },
});
