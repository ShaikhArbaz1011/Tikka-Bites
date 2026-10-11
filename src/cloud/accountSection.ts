/** Settings → Account & sync (shared database only). */
import '../styles/auth.css';
import { h, replaceChildren } from '../ui/dom';
import { toggle } from '../ui/components/form';
import { confirmDialog } from '../ui/components/modal';
import { toast } from '../ui/components/toast';
import { currentSession, signOut } from './auth';
import { onSheets } from './config';
import { biometricAvailable, biometricEnrolled, disableBiometric, enrollBiometric } from './biometric';
import { pendingBills, voidPendingLocally } from './localStore';
import { onSyncState, syncNow } from './sync';
import { syncLabel } from './syncPill';
import { formatINR } from '../core/money';
import { formatDateTime } from '../core/dates';

export async function accountSection(): Promise<{ body: HTMLElement; cleanup(): void }> {
  const s = currentSession();
  const who = h('p', {}, 'Signed in as ', h('strong', { text: s?.username ?? '—' }));
  const out = h('button', { class: 'btn', text: 'Sign out', attrs: { type: 'button' } });
  out.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Sign out?', message: 'Bills made offline that are still waiting will upload after the next sign-in on this phone.', confirmLabel: 'Sign out' });
    if (!ok) return;
    await signOut(); // the sign-in screen opens (boot.ts)
  });

  const status = h('p', { attrs: { role: 'status' } });
  const syncBtn = h('button', { class: 'btn btn-primary', text: 'Sync now', attrs: { type: 'button' } });
  const attention = h('ul', { class: 'attention-list', attrs: { 'aria-label': 'Bills that could not be uploaded' } });

  const renderAttention = async () => {
    const refused = (await pendingBills()).filter((b) => b.sync?.error && b.status === 'paid');
    replaceChildren(
      attention,
      ...refused.map((b) => {
        const retry = h('button', { class: 'btn btn-sm', text: 'Retry upload', attrs: { type: 'button' } });
        const cancel = h('button', { class: 'btn btn-sm btn-danger', text: 'Cancel this bill', attrs: { type: 'button' } });
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          await syncNow({ retryRefused: true });
          await renderAttention();
        });
        cancel.addEventListener('click', async () => {
          const ok = await confirmDialog({ title: `Cancel ${b.billNo}?`, message: 'It will stay on this phone as a voided bill and will not be uploaded.', confirmLabel: 'Cancel bill', danger: true });
          if (!ok) return;
          await voidPendingLocally(b.billNo, `Not uploaded: ${b.sync?.error ?? 'refused'}`.slice(0, 200));
          toast(`${b.billNo} cancelled`, 'success');
          await renderAttention();
        });
        return h(
          'li',
          { class: 'attention-row' },
          h('strong', { text: `${b.billNo} · ${formatINR(b.totalPaise)} · ${formatDateTime(b.createdAt)}` }),
          h('span', { class: 'muted', text: b.sync?.error ?? '' }),
          h('div', { class: 'btn-row' }, retry, cancel),
        );
      }),
    );
    attention.hidden = refused.length === 0;
  };

  const off = onSyncState((st) => {
    const when = st.lastSyncAt ? ` · last synced ${formatDateTime(st.lastSyncAt)}` : '';
    status.textContent = `${syncLabel(st)}${when}${st.message && st.status !== 'synced' ? ` — ${st.message}` : ''}`;
    void renderAttention();
  });
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    const st = await syncNow();
    syncBtn.disabled = false;
    toast(st.status === 'synced' ? 'Everything is synced' : syncLabel(st), st.status === 'synced' ? 'success' : 'info');
  });

  const fp = h('div', { class: 'btn-row' });
  if (s && (await biometricAvailable())) {
    const on = await biometricEnrolled(s.username);
    const sw = toggle('Unlock with fingerprint on this phone', on);
    sw.addEventListener('click', async () => {
      const enable = sw.getAttribute('aria-checked') !== 'true';
      try {
        if (enable) await enrollBiometric(s.username);
        else await disableBiometric();
        sw.setAttribute('aria-checked', String(enable));
        toast(enable ? 'Fingerprint unlock is on' : 'Fingerprint unlock is off', 'success');
      } catch {
        toast('Fingerprint was not set up', 'error');
      }
    });
    fp.append(sw, h('span', { text: 'Unlock with fingerprint on this phone' }));
  } else {
    fp.append(h('span', { class: 'muted', text: 'This device has no fingerprint sensor the browser can use.' }));
  }

  const body = h(
    'div',
    { class: 'form-grid' },
    h('div', { class: 'btn-row' }, who, out),
    fp,
    status,
    h('div', { class: 'btn-row' }, syncBtn),
    attention,
    h('p', {
      class: 'muted',
      text: onSheets()
        ? 'This month and the 2 before it are kept on every phone and in the Main Google Sheet. Older months stay in the Backup Google Sheet in the owner’s Google Drive.'
        : 'Only this month and the 2 before it are kept, on every phone and in the shared database. On the 1st of each month the oldest month is deleted, so download its Excel from Reports before then.',
    }),
  );
  return { body, cleanup: off };
}
