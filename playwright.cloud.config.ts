import { defineConfig, devices } from '@playwright/test';

// End-to-end tests of the SHARED DATABASE mode on this PC:
//  - scripts/fake-supabase.mjs answers like Supabase and runs real SQL (supabase/schema.sql)
//    in a local PostgreSQL (set PGHOST/PGPORT/PGUSER and PG_BIN if psql isn't on PATH)
//  - the app is built pointing at it and served like GitHub Pages (sub-folder, CSP in <meta>)
// Run: npm run e2e:cloud
const SUPABASE = 'http://localhost:54321';
const KEY = 'anon-key-for-local-e2e-0000000000';

export default defineConfig({
  testDir: 'tests/e2e-cloud',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4178/Tikka-Bites/', trace: 'retain-on-failure', timezoneId: 'Asia/Kolkata', locale: 'en-IN' },
  webServer: [
    {
      command: 'node scripts/fake-supabase.mjs 54321',
      url: `${SUPABASE}/auth/v1/logout`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npx vite build --outDir dist-cloud --emptyOutDir && node scripts/serve-dist.mjs 4178 --root dist-cloud --pages /Tikka-Bites/',
      url: 'http://localhost:4178/Tikka-Bites/',
      env: { VITE_CLOUD_BACKEND: 'supabase', VITE_SUPABASE_URL: SUPABASE, VITE_SUPABASE_ANON_KEY: KEY },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
});
