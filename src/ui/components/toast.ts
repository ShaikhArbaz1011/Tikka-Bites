import { h } from '../dom';

type Kind = 'info' | 'success' | 'error';

/** Show a short, auto-dismissing message in the polite live region. */
export function toast(message: string, kind: Kind = 'info', ms = 3000): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h('div', { class: `toast toast-${kind}`, text: message });
  host.append(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 250);
  }, ms);
}
