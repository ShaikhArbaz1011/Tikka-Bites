import { h } from '../dom';
import { icon } from './icons';
import { getSettings } from '../../db/settingsRepo';
import { countBills } from '../../db/backup';

const DAY = 86_400_000;
const DISMISS_KEY = 'restobill.backupBannerDismissed';

function dismissedThisSession(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/** Gentle reminder when the last backup is older than 7 days (or never, with bills present). */
export async function showBackupReminder(slot: HTMLElement, now = Date.now()): Promise<void> {
  if (dismissedThisSession()) return;
  const s = await getSettings();
  const days = s.lastBackupAt ? Math.floor((now - s.lastBackupAt) / DAY) : Infinity;
  if (days < 7) return;
  if (!s.lastBackupAt && (await countBills()) === 0) return;

  const msg = s.lastBackupAt
    ? `Your last backup was ${days} days ago.`
    : 'You haven’t backed up your bills yet.';
  const backupBtn = h('button', { class: 'btn btn-sm btn-primary', text: 'Back up now', attrs: { type: 'button' } });
  const close = h('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': 'Dismiss reminder' } }, icon('x', 18));
  const banner = h(
    'div',
    { class: 'banner', attrs: { role: 'status' } },
    icon('download', 18),
    h('p', { class: 'banner-text' }, h('strong', { text: msg }), ' Your data is stored only on this device.'),
    backupBtn,
    close,
  );
  const hide = () => banner.remove();
  close.addEventListener('click', () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode: dismiss for this page only */
    }
    hide();
  });
  backupBtn.addEventListener('click', async () => {
    const { runBackup } = await import('../settings/backupActions');
    await runBackup();
  });
  document.addEventListener('backup-done', hide, { once: true });
  slot.replaceChildren(banner);
}
