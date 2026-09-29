/** Small status pill in the nav and phone top bar: Synced / 3 waiting / Offline. Links to Settings. */
import { h } from '../ui/dom';
import { onSyncState, type SyncState } from './sync';

export function syncLabel(s: SyncState): string {
  if (s.attention) return `${s.attention} not uploaded`;
  if (s.status === 'offline') return s.waiting ? `Offline · ${s.waiting} waiting` : 'Offline';
  if (s.status === 'signed-out') return 'Signed out';
  if (s.status === 'not-staff') return 'No access';
  if (s.status === 'needs-setup') return 'Setup needed';
  if (s.status === 'error') return 'Sync problem';
  if (s.waiting) return `${s.waiting} waiting`;
  return s.status === 'syncing' ? 'Syncing…' : 'Synced';
}

export function mountSyncPills(): void {
  const pills: HTMLAnchorElement[] = [];
  for (const host of [document.querySelector('.nav-foot'), document.getElementById('topbar')]) {
    if (!host) continue;
    const pill = h('a', { class: 'sync-pill', attrs: { href: '#/settings', 'aria-live': 'polite' } }, h('span', { class: 'sync-text' }));
    if (host.id === 'topbar') host.insertBefore(pill, host.lastElementChild);
    else host.prepend(pill);
    pills.push(pill);
  }
  onSyncState((s) => {
    const label = syncLabel(s);
    for (const p of pills) {
      p.dataset['status'] = s.attention ? 'error' : s.status;
      p.querySelector('.sync-text')!.textContent = label;
      p.title = s.message ?? label;
      p.setAttribute('aria-label', `Shared database: ${label}`);
    }
  });
}
