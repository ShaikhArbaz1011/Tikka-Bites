import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against the PRODUCTION build, served with the same
// security headers as Netlify/Vercel (scripts/serve-dist.mjs).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: true,
  reporter: [['list']],
  // The shop is in India: run the browser on IST so dates match the counter.
  use: { baseURL: 'http://localhost:4174', trace: 'retain-on-failure', timezoneId: 'Asia/Kolkata', locale: 'en-IN' },
  webServer: {
    command: 'npm run build && node scripts/serve-dist.mjs 4174',
    url: 'http://localhost:4174',
    // These tests cover LOCAL-ONLY mode: empty values override cloud.config.json (shared mode: npm run e2e:cloud).
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { ...devices['Pixel 5'] } },
  ],
});
