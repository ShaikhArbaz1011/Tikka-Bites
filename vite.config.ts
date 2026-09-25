import { defineConfig, type Plugin } from 'vitest/config';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

/** Emit /sw.js with the exact list of built files to precache (no Workbox needed). */
function serviceWorker(): Plugin {
  return {
    name: 'restobill-sw',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const publicFiles = (dir: string): string[] =>
        readdirSync(dir).flatMap((f) => {
          const p = join(dir, f);
          return statSync(p).isDirectory() ? publicFiles(p) : ['/' + relative('public', p).split(sep).join('/')];
        });
      const files = ['/', '/index.html', ...Object.keys(bundle).filter((f) => f !== 'index.html').map((f) => `/${f}`), ...publicFiles('public')];
      const version = createHash('sha256').update(files.join('|')).digest('hex').slice(0, 10);
      const source = readFileSync('src/sw.js', 'utf8')
        .replace('__PRECACHE__', JSON.stringify(files))
        .replace('__VERSION__', version);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [serviceWorker()],
  build: {
    target: 'es2022',
    modulePreload: { polyfill: false },
    cssCodeSplit: true,
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
