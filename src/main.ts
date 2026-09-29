import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/billing.css';
import './styles/print.css';

import { $ } from './ui/dom';
import { renderNav } from './ui/components/nav';
import { showBackupReminder } from './ui/components/backupBanner';
import { showRetentionReminder } from './ui/components/retentionBanner';
import { toast } from './ui/components/toast';
import { startRouter } from './router';
import { registerServiceWorker } from './pwa';
import { applyTheme } from './theme';
import { cloudEnabled } from './cloud/config';
import { purgeOldMonths } from './db/retention';

applyTheme();

// Safety net: a save that fails (e.g. a menu change with no internet in shared mode)
// says why instead of failing silently. These messages are written for staff.
const FRIENDLY = new Set(['CloudError', 'BillError', 'MenuError', 'LineError']);
window.addEventListener('unhandledrejection', (e) => {
  const r: unknown = e.reason;
  const name = r instanceof Error ? r.name : '';
  if (FRIENDLY.has(name)) e.preventDefault(); // shown to staff below; not a bug in the app
  toast(r instanceof Error && FRIENDLY.has(name) ? r.message : 'Something went wrong. Please try again.', 'error', 6000);
});

void (async () => {
  const setActive = renderNav($('#nav'), $('#topbar'));
  const slot = $('#banner-slot');

  if (cloudEnabled()) {
    // Sign in / fingerprint, first-time setup, then keep syncing (lazy-loaded).
    const { startCloud } = await import('./cloud/boot');
    await startCloud();
  } else {
    // Only 3 months are kept: this month and the 2 before it.
    await purgeOldMonths().catch(() => undefined);
    let month = new Date().getMonth();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || new Date().getMonth() === month) return;
      month = new Date().getMonth(); // a new month started while the app was open
      void purgeOldMonths().catch(() => undefined);
    });
    void showBackupReminder(slot); // with the shared database the data is already safe on the server
  }

  startRouter($('#view'), setActive);
  void showRetentionReminder(slot);

  // Ask the browser not to evict our IndexedDB data under storage pressure.
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* not supported: backups are the safety net */
  }
})();

registerServiceWorker();
