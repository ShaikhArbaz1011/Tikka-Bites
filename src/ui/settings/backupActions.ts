import { exportBackup, importBackup, markBackedUp } from '../../db/backup';
import { validateBackup, MAX_BACKUP_BYTES } from '../../core/backupSchema';
import { formatDateISO, formatDateTime } from '../../core/dates';
import { downloadBlob } from '../download';
import { confirmDialog } from '../components/modal';
import { toast } from '../components/toast';

/** Download a full JSON backup and record the time. */
export async function runBackup(): Promise<void> {
  const now = Date.now();
  const blob = await exportBackup(now);
  downloadBlob(blob, `restobill-backup-${formatDateISO(now)}.json`);
  await markBackedUp(now);
  document.dispatchEvent(new CustomEvent('backup-done'));
  toast('Backup downloaded — keep it somewhere safe', 'success');
}

/** Validate a backup file, confirm with the user, then replace all data. */
export async function runRestore(file: File): Promise<boolean> {
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
  toast('Backup restored', 'success');
  return true;
}
