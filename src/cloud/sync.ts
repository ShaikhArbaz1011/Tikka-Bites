/**
 * Sync: upload bills made offline, then fetch everything that changed.
 * Upload FIRST, so a bill whose reply was lost is matched by the retry
 * (same clientRef) before the download could bring it in a second time.
 * One sync at a time; runs at start, when the internet comes back, when the
 * app is opened again and every 30 seconds while it is on screen.
 */
import { api, type PullPage } from './api';
import { CloudError } from './errors';
import { applyChanges, pendingBills, resetSharedCopy, setSyncError } from './localStore';
import { getMeta, setMeta } from '../db/settingsRepo';
import { purgeOldMonths } from '../db/retention';
import { refreshMenu } from '../state/menuStore';
import type { Bill } from '../db/types';

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'signed-out' | 'not-staff' | 'needs-setup' | 'error';

export interface SyncState {
  status: SyncStatus;
  /** Offline bills waiting to upload. */
  waiting: number;
  /** Offline bills the server refused (shown in Settings → Account & sync). */
  attention: number;
  lastSyncAt?: number;
  message?: string;
}

let state: SyncState = { status: 'syncing', waiting: 0, attention: 0 };
const listeners = new Set<(s: SyncState) => void>();
let running: Promise<SyncState> | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let purgedServerToday = '';

export function syncState(): SyncState {
  return state;
}

export function onSyncState(fn: (s: SyncState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

function emit(patch: Partial<SyncState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('sync-state', { detail: state }));
}

/** The body sent for a bill made offline: it keeps its sale time, prices and printed number. */
export function offlinePayload(b: Bill): Record<string, unknown> {
  return {
    offline: true,
    clientRef: b.sync?.clientRef,
    printedAs: b.billNo,
    createdAt: b.createdAt,
    items: b.items.map((i) => ({ menuId: i.menuId, qty: i.qty, unitPaise: i.unitPaise, name: i.name, category: i.category, isVeg: i.isVeg })),
    orderType: b.orderType,
    tableNo: b.tableNo,
    customerName: b.customerName,
    paymentMode: b.paymentMode,
    discount: b.discount,
    roundOffPaise: b.roundOffPaise,
    totalPaise: b.totalPaise,
    cheesyLine: b.cheesyLine,
    ...(b.enteredAt !== undefined ? { enteredAt: b.enteredAt } : {}),
  };
}

async function countPending(): Promise<{ waiting: number; attention: number }> {
  const all = await pendingBills();
  const attention = all.filter((b) => b.sync?.error).length;
  return { waiting: all.length - attention, attention };
}

/** Upload waiting offline bills. `retryRefused` also retries ones the server refused before. */
async function push(retryRefused: boolean): Promise<void> {
  for (const b of await pendingBills()) {
    if (b.sync?.error && !retryRefused) continue;
    if (b.status !== 'paid') continue;
    try {
      const saved = await api.saveBill(offlinePayload(b));
      await applyChanges({ bills: [saved] }, new Map([[saved.billNo, b.billNo]]));
    } catch (e) {
      if (e instanceof CloudError && e.kind === 'rejected') {
        await setSyncError(b.billNo, e.message); // kept on this phone; the owner can retry or cancel it
        continue;
      }
      throw e; // offline / signed out: stop and try again later
    }
  }
}

/** Download every change since the last sync. Returns false if the database isn't set up yet. */
async function pull(): Promise<boolean> {
  let since = (await getMeta('cloudRev')) ?? 0;
  let knownDb = await getMeta('cloudDbId');
  let renumberSeen = (await getMeta('renumberSeen')) ?? 0;
  let page: PullPage;
  let menuChanged = false;
  let billsChanged = false;
  for (let guard = 0; guard < 10_000; guard++) {
    page = await api.pullChanges(since);
    if (!page.ready) return false;
    if (knownDb && page.dbId !== knownDb) {
      // The shared database was re-created: start this phone's copy again.
      await resetSharedCopy();
      knownDb = undefined;
      renumberSeen = 0;
      since = 0;
      continue;
    }
    if ((page.renumberRev ?? 0) > renumberSeen) {
      renumberSeen = page.renumberRev ?? 0;
      if (since > 0) {
        // Receipt numbers were changed in a way this copy can't follow bill by bill (the one-time
        // renumbering in date order, or a number that moved into another month): copy everything again.
        await resetSharedCopy();
        await setMeta('renumberSeen', renumberSeen);
        knownDb = undefined;
        since = 0;
        continue;
      }
      await setMeta('renumberSeen', renumberSeen); // a copy from the start already has the new numbers
    }
    await applyChanges(page);
    menuChanged ||= page.menu.length > 0;
    billsChanged ||= page.bills.length > 0;
    since = page.rev;
    await setMeta('cloudRev', since);
    if (!knownDb) {
      await setMeta('cloudDbId', page.dbId);
      knownDb = page.dbId;
    }
    if (!page.more) {
      await purgeOldMonths(page.keepFrom); // same 3 months as the server
      break;
    }
  }
  if (menuChanged) await refreshMenu();
  // Open screens (Reports) redraw with bills from other phones.
  if (billsChanged && typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('cloud-data-changed'));
  return true;
}

/** Run one sync (or join the one already running). Never throws; the result is in the state. */
export function syncNow(opts: { retryRefused?: boolean } = {}): Promise<SyncState> {
  running ??= (async () => {
    emit({ status: 'syncing', message: undefined });
    try {
      if (!navigator.onLine) throw new CloudError('No internet connection.', 'offline');
      await push(!!opts.retryRefused);
      const ready = await pull();
      if (!ready) {
        emit({ status: 'needs-setup', ...(await countPending()) });
        return state;
      }
      const now = Date.now();
      await setMeta('lastSyncAt', now);
      // Also ask the server to clear months past the limit (the nightly job does it too).
      const today = new Date(now).toDateString();
      if (purgedServerToday !== today) {
        purgedServerToday = today;
        void api.purgeOldMonths().catch(() => undefined);
      }
      emit({ status: 'synced', lastSyncAt: now, ...(await countPending()) });
    } catch (e) {
      const kind = e instanceof CloudError ? e.kind : 'server';
      const status: SyncStatus = kind === 'offline' ? 'offline' : kind === 'auth' ? 'signed-out' : kind === 'not-staff' ? 'not-staff' : 'error';
      emit({ status, message: e instanceof Error ? e.message : String(e), lastSyncAt: await getMeta('lastSyncAt'), ...(await countPending()) });
    } finally {
      running = null;
    }
    return state;
  })();
  return running;
}

/** Keep syncing in the background while the app is open. */
export function startAutoSync(): () => void {
  const kick = () => void syncNow();
  const onVisible = () => {
    if (document.visibilityState === 'visible') kick();
  };
  window.addEventListener('online', kick);
  window.addEventListener('offline', () => emit({ status: 'offline' }));
  document.addEventListener('visibilitychange', onVisible);
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') kick();
  }, 30_000);
  kick();
  return () => {
    window.removeEventListener('online', kick);
    document.removeEventListener('visibilitychange', onVisible);
    if (timer) clearInterval(timer);
  };
}

/** Tests only. */
export function resetSyncForTests(): void {
  state = { status: 'syncing', waiting: 0, attention: 0 };
  listeners.clear();
  running = null;
  purgedServerToday = '';
}
