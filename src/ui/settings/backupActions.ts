import { exportBackup, importBackup, markBackedUp } from '../../db/backup';
import { validateBackup, MAX_BACKUP_BYTES } from '../../core/backupSchema';
import { formatDateISO, formatDateTime } from '../../core/dates';
import { downloadBlob } from '../download';
import { confirmDialog } from '../components/modal';
import { toast } from '../components/toast';
import { cloudEnabled } from '../../cloud/config';
import { purgeOldMonths } from '../../db/retention';

/** Download a full JSON backup and record the time. */
export async function runBackup(): Promise<void> {
  const now = Date.now();
  const blob = await exportBackup(now);
  downloadBlob(blob, `TikkaBites-backup-${formatDateISO(now)}.json`);
  await markBackedUp(now);
  document.dispatchEvent(new CustomEvent('backup-done'));
  toast('Backup downloaded — keep it somewhere safe', 'success');
}

/** Validate a backup file, confirm with the user, then replace all data. */
export async function runRestore(file: File): Promise<boolean> {
  if (cloudEnabled()) {
    // The shared database is the master copy for every phone; restoring one phone would put it out of step.
    toast('Restore is turned off while the shared database is on: every phone already gets the shared data.', 'error', 7000);
    return false;
  }
  if (file.size > MAX_BACKUP_BYTES) {
    toast('Backup file is too large (max 50 MB)', 'error');
    return false;
  }
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('This file is not valid JSON', 'error', 5000);
    return false;
  }
  const result = validateBackup(data);
  if (!result.ok) {
    toast(`Backup rejected — ${result.error}`, 'error', 8000);
    return false;
  }
  const b = result.backup;
  const ok = await confirmDialog({
    title: 'Replace all data?',
    message: `This backup from ${formatDateTime(b.exportedAt)} has ${b.bills.length.toLocaleString('en-IN')} bills and ${b.menu.length} dishes. Everything currently on this device will be replaced. This cannot be undone.`,
    confirmLabel: 'Replace data',
    danger: true,
  });
  if (!ok) return false;
  await importBackup(b);
  await purgeOldMonths(); // only the last 3 months are kept
  toast('Backup restored', 'success');
  return true;
}
