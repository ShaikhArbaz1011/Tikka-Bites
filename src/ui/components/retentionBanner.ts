import { h } from '../dom';
import { icon } from './icons';
import { getDB } from '../../db/db';
import { getSettings } from '../../db/settingsRepo';
import { formatMonthKey, keepFromMonth, monthKeyRange } from '../../core/dates';

/** Show the reminder in the last days of the month. */
export const REMIND_DAYS_BEFORE = 7;
const DISMISS_KEY = 'restobill.retentionBannerDismissed.';

/**
 * Month whose bills are deleted when the next month starts (only 3 months are kept),
 * and the date that happens — or null if it isn't the last days of the month yet.
 */
export function retentionWarning(now = Date.now()): { monthKey: string; on: Date } | null {
  const d = new Date(now);
  const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const daysLeft = Math.round((+nextMonth - +new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000);
  if (daysLeft > REMIND_DAYS_BEFORE) return null;
  return { monthKey: keepFromMonth(now), on: nextMonth };
}

function dismissed(monthKey: string): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY + monthKey) === '1';
  } catch {
    return false;
  }
}

/** "On 1 Oct, July's bills are deleted — download July's Excel now." */
export async function showRetentionReminder(slot: HTMLElement, now = Date.now()): Promise<void> {
  const w = retentionWarning(now);
  if (!w || dismissed(w.monthKey)) return;
  const range = monthKeyRange(w.monthKey);
  const db = await getDB();
  const count = await db.countFromIndex('bills', 'monthKey', w.monthKey);
  if (!count) return;

  const month = formatMonthKey(w.monthKey);
  const when = `${w.on.getDate()} ${formatMonthKey(`${w.on.getFullYear()}${String(w.on.getMonth() + 1).padStart(2, '0')}`).slice(0, 3)}`;
  const btn = h('button', { class: 'btn btn-sm btn-primary', attrs: { type: 'button' } }, `Download ${month} Excel`);
  const close = h('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': 'Dismiss reminder' } }, icon('x', 18));
  const banner = h(
    'div',
    { class: 'banner', attrs: { role: 'status' } },
    icon('download', 18),
    h('p', { class: 'banner-text' }, h('strong', { text: `On ${when}, ${month} bills will be deleted.` }), ' Only 3 months are kept. Download them first if you need them.'),
    btn,
    close,
  );
  close.addEventListener('click', () => {
    try {
      sessionStorage.setItem(DISMISS_KEY + w.monthKey, '1');
    } catch {
      /* private mode */
    }
    banner.remove();
  });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const { exportExcel } = await import('../reports/exportExcel');
      await exportExcel({ range, showVoid: true }, month, (await getSettings()).name);
    } finally {
      btn.disabled = false;
    }
  });
  slot.append(banner);
}
