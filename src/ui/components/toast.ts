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

/** A persistent toast with one action button (e.g. "Update available — Reload"). */
export function actionToast(message: string, label: string, onAction: () => void): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const btn = h('button', { class: 'toast-action', text: label, attrs: { type: 'button' } });
  const el = h('div', { class: 'toast toast-sticky' }, h('span', { text: message }), btn);
  btn.addEventListener('click', () => {
    el.remove();
    onAction();
  });
  host.append(el);
}
