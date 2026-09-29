/**
 * Start-up when the shared database is on (loaded only in that case):
 *   1. sign in (User ID + password), or unlock with the fingerprint
 *   2. first time on this database: set it up from this phone, or join it
 *   3. plug the shared-database saving in (db/hooks.ts) and keep syncing
 * Resolves when the app can be shown.
 */
import { loadSession, onSessionChange, currentSession, signOut } from './auth';
import { biometricEnrolled } from './biometric';
import { showSignIn, showLock, offerBiometric, showNotice, showBusy } from './screens';
import { api } from './api';
import { CloudError } from './errors';
import { cloudRepo } from './cloudRepo';
import { resetSharedCopy } from './localStore';
import { startAutoSync, syncNow } from './sync';
import { mountSyncPills } from './syncPill';
import { setCloudHooks } from '../db/hooks';
import { getDB } from '../db/db';
import { getMeta } from '../db/settingsRepo';
import { purgeOldMonths } from '../db/retention';
import { listMenu } from '../db/menuRepo';
import { listLines } from '../db/linesRepo';
import { getSettings } from '../db/settingsRepo';
import type { Bill } from '../db/types';
import { REFRESH_EVENT } from '../router';

/** Lock again when the app comes back after this long in the background. */
const RELOCK_AFTER_MS = 5 * 60_000;

async function signInFlow(message?: string): Promise<void> {
  const last = currentSession()?.username ?? (await getMeta('biometric'))?.username;
  await showSignIn({ username: last, message });
  const s = currentSession();
  if (s && !(await biometricEnrolled(s.username))) await offerBiometric(s.username);
}

async function unlockFlow(): Promise<void> {
  const s = await loadSession();
  if (!s) return signInFlow();
  if (!(await biometricEnrolled(s.username))) return;
  const r = await showLock(s.username);
  if (r === 'password') {
    await signOut();
    await signInFlow();
  }
}

async function countLocal(): Promise<{ bills: number; dishes: number }> {
  const db = await getDB();
  return { bills: await db.count('bills'), dishes: await db.count('menu') };
}

/** Move this phone's menu, settings and bills (kept months only) into an empty shared database. */
async function setUpFromThisPhone(): Promise<void> {
  const busy = showBusy('Setting up the shared database', 'Copying the menu and settings…');
  try {
    await purgeOldMonths();
    const db = await getDB();
    await api.importDeviceData(await listMenu(true), await listLines(), await getSettings(), await db.getAll('counters'));
    const all: Bill[] = await db.getAll('bills');
    for (let i = 0; i < all.length; i += 500) {
      busy.set(`Uploading bills ${Math.min(i + 500, all.length).toLocaleString('en-IN')} of ${all.length.toLocaleString('en-IN')}…`);
      await api.importBills(all.slice(i, i + 500));
    }
    await api.finishImport();
    busy.set('Almost done…');
  } finally {
    busy.close();
  }
}

/** Make sure this phone's copy belongs to the shared database before anything is saved. */
async function ensureJoined(): Promise<void> {
  for (;;) {
    if (await getMeta('cloudDbId')) return; // already joined
    let page;
    try {
      page = await api.pullChanges(0, 1);
    } catch (e) {
      const msg = e instanceof CloudError ? e.message : 'Could not reach the shared database.';
      if (e instanceof CloudError && e.kind === 'auth') {
        await signInFlow(msg);
        continue;
      }
      await showNotice({ title: 'Connect to the internet', body: `${msg} This phone needs the internet once to download the shared menu and bills.`, primary: 'Try again' });
      continue;
    }
    const local = await countLocal();
    if (!page.ready) {
      await showNotice({
        title: 'Set up the shared database',
        body:
          local.dishes || local.bills
            ? `The shared database is empty. This phone's menu (${local.dishes} dishes), settings and bills from the last 3 months will be copied into it, and every phone will then use the same data.`
            : 'The shared database is empty. It will start from this phone; then load the Tikka Bites menu from the Menu screen.',
        primary: 'Set up from this phone',
      });
      try {
        await setUpFromThisPhone();
      } catch (e) {
        await showNotice({ title: 'Setup did not finish', body: e instanceof Error ? e.message : String(e), primary: 'Try again' });
        continue;
      }
    } else if (local.bills || local.dishes) {
      const choice = await showNotice({
        title: 'Join the shared database',
        body: `This phone has its own data (${local.dishes} dishes, ${local.bills} bills). Joining replaces it with the shared menu and bills. If you need this phone's bills, download a backup first (Settings → Backup).`,
        primary: 'Join and replace',
        secondary: 'Download backup first',
      });
      if (choice === 'secondary') {
        const { runBackup } = await import('../ui/settings/backupActions');
        await runBackup().catch(() => undefined);
        continue;
      }
      await resetSharedCopy();
    }
    const busy = showBusy('Downloading', 'Getting the menu and bills from the shared database…');
    const st = await syncNow();
    busy.close();
    if (await getMeta('cloudDbId')) return;
    await showNotice({ title: 'Could not download', body: st.message ?? 'Please check the internet and try again.', primary: 'Try again' });
  }
}

function relockWhenAway(): void {
  let hiddenAt = 0;
  let locking = false;
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      return;
    }
    if (locking || !hiddenAt || Date.now() - hiddenAt < RELOCK_AFTER_MS) return;
    const s = currentSession();
    if (!s || !(await biometricEnrolled(s.username))) return;
    locking = true;
    try {
      await unlockFlow();
    } finally {
      locking = false;
    }
  });
}

export async function startCloud(): Promise<void> {
  await unlockFlow();
  if (!(await loadSession())) await signInFlow();
  await ensureJoined();
  setCloudHooks(cloudRepo);
  mountSyncPills();
  startAutoSync();
  relockWhenAway();
  // Signed out (here, or the sign-in expired and couldn't be renewed): ask again.
  onSessionChange((s) => {
    if (!s) {
      void signInFlow('Please sign in again.').then(() => {
        // The screen behind the sign-in belonged to the previous person (e.g. Settings → Users).
        window.dispatchEvent(new Event(REFRESH_EVENT));
        return syncNow();
      });
    }
  });
}
