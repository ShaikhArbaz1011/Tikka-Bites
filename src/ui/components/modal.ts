import { h } from '../dom';
import { icon } from './icons';

/**
 * Accessible modal built on the native <dialog> element (focus trapping,
 * Esc to close and inert background come for free).
 */
export function openModal(opts: {
  title: string;
  body: Node;
  actions?: Node[];
  onClose?: () => void;
  wide?: boolean;
}): { dialog: HTMLDialogElement; close: () => void } {
  const titleId = `m-${Math.random().toString(36).slice(2, 8)}`;
  const closeBtn = h('button', { class: 'icon-btn', attrs: { type: 'button', 'aria-label': 'Close' } }, icon('x'));
  const dialog = h(
    'dialog',
    { class: `modal${opts.wide ? ' modal-wide' : ''}`, attrs: { 'aria-labelledby': titleId } },
    h('div', { class: 'modal-head' }, h('h2', { class: 'modal-title', text: opts.title, attrs: { id: titleId } }), closeBtn),
    h('div', { class: 'modal-body' }, opts.body),
    opts.actions?.length ? h('div', { class: 'modal-actions' }, ...opts.actions) : null,
  );
  const close = () => {
    if (dialog.open) dialog.close();
  };
  closeBtn.addEventListener('click', close);
  // Click on the backdrop closes.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    opts.onClose?.();
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

/** Promise-based confirm dialog. */
export function confirmDialog(opts: { title: string; message: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const cancel = h('button', { class: 'btn', text: 'Cancel', attrs: { type: 'button' } });
    const ok = h('button', { class: `btn ${opts.danger ? 'btn-danger-solid' : 'btn-primary'}`, text: opts.confirmLabel, attrs: { type: 'button' } });
    const m = openModal({
      title: opts.title,
      body: h('p', { text: opts.message }),
      actions: [cancel, ok],
      onClose: () => resolve(result),
    });
    cancel.addEventListener('click', m.close);
    ok.addEventListener('click', () => {
      result = true;
      m.close();
    });
    ok.focus();
  });
}
