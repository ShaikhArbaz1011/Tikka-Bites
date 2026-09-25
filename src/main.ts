import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/billing.css';
import './styles/print.css';

import { $ } from './ui/dom';
import { renderNav } from './ui/components/nav';
import { showBackupReminder } from './ui/components/backupBanner';
import { startRouter } from './router';
import { registerServiceWorker } from './pwa';

const setActive = renderNav($('#nav'));
startRouter($('#view'), setActive);

// Ask the browser not to evict our IndexedDB data under storage pressure.
void (async () => {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* not supported: backups are the safety net */
  }
})();

void showBackupReminder($('#banner-slot'));
registerServiceWorker();
