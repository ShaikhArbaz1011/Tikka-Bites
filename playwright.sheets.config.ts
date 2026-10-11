import { defineConfig, devices } from '@playwright/test';

// End-to-end tests of the GOOGLE SHEETS mode on this PC:
//  - scripts/fake-sheets.mjs answers like Google's web app and runs the real
//    google-sheets/Code.gs on sheets that behave like Google Sheets
//  - the app is built pointing at it and served like GitHub Pages (sub-folder, CSP in <meta>)
// Run: npm run e2e:sheets
export const SHEETS = 'http://localhost:54330';
const EXEC = `${SHEETS}/macros/s/fake-e2e-deployment/exec`;

export default defineConfig({
  testDir: 'tests/e2e-sheets',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4179/Tikka-Bites/', trace: 'retain-on-failure', timezoneId: 'Asia/Kolkata', locale: 'en-IN' },
  webServer: [
    {
      command: 'node scripts/fake-sheets.mjs 54330',
      url: EXEC,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npx vite build --outDir dist-sheets --emptyOutDir && node scripts/serve-dist.mjs 4179 --root dist-sheets --pages /Tikka-Bites/',
      url: 'http://localhost:4179/Tikka-Bites/',
      env: { VITE_CLOUD_BACKEND: 'sheets', VITE_SHEETS_URL: EXEC },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
});
