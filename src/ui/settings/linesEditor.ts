import { h, replaceChildren } from '../dom';
import { icon } from '../components/icons';
import { toggle } from '../components/form';
import { confirmDialog } from '../components/modal';
import { toast } from '../components/toast';
import { listLines, addLine, updateLine, deleteLine, LineError } from '../../db/linesRepo';
import { LIMITS } from '../../core/validate';
import type { CheesyLine } from '../../db/types';

/** Editor for the funny sign-off lines printed at the bottom of receipts. */
export async function linesEditor(): Promise<HTMLElement> {
  let lines: CheesyLine[] = await listLines();
  const summary = h('p', { class: 'muted' });
  const input = h('input', {
    class: 'input',
    attrs: { type: 'text', maxlength: LIMITS.cheesyLine, placeholder: 'Add your own line…', 'aria-label': 'New receipt line' },
  });
  const addBtn = h('button', { class: 'btn btn-primary', attrs: { type: 'submit' } }, icon('plus', 18), 'Add');
  const form = h('form', { class: 'inline-form' }, input, addBtn);
  const list = h('ul', { class: 'lines-list', attrs: { 'aria-label': 'Receipt lines' } });

  const render = () => {
    const active = lines.filter((l) => l.active).length;
    summary.textContent = `${active} of ${lines.length} lines in use. A random one prints on each bill — no repeats until all are used.`;
    replaceChildren(
      list,
      ...[...lines].reverse().map((l) => {
        const text = h('input', { class: 'input line-text', attrs: { type: 'text', maxlength: LIMITS.cheesyLine, 'aria-label': 'Line text', 'data-action': 'edit' } });
        text.value = l.text;
        return h(
          'li',
          { class: `line-row${l.active ? '' : ' is-disabled'}`, dataset: { id: String(l.id) } },
          text,
          l.builtIn ? h('span', { class: 'tag', text: 'Built-in' }) : null,
          toggle('Use this line', l.active, { 'data-action': 'toggle' }),
          h('button', { class: 'icon-btn icon-btn-danger', attrs: { type: 'button', 'data-action': 'delete', 'aria-label': 'Delete line' } }, icon('trash', 18)),
        );
      }),
    );
  };

  const reload = async () => {
    lines = await listLines();
    render();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await addLine(input.value);
      input.value = '';
      await reload();
      toast('Line added', 'success');
    } catch (err) {
      toast(err instanceof LineError ? err.message : 'Could not add line', 'error');
    }
  });

  list.addEventListener('change', async (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset['action'] !== 'edit') return;
    const id = Number(el.closest<HTMLElement>('.line-row')?.dataset['id']);
    try {
      await updateLine(id, { text: el.value });
      toast('Line saved', 'success', 1500);
      await reload();
    } catch (err) {
      toast(err instanceof LineError ? err.message : 'Could not save line', 'error');
      el.value = lines.find((l) => l.id === id)?.text ?? '';
    }
  });

  list.addEventListener('click', async (e) => {
    const btn = (e.target as Element).closest<HTMLElement>('[data-action]');
    const id = Number(btn?.closest<HTMLElement>('.line-row')?.dataset['id']);
    const line = lines.find((l) => l.id === id);
    if (!btn || !line) return;
    if (btn.dataset['action'] === 'toggle') {
      await updateLine(id, { active: !line.active });
      await reload();
    } else if (btn.dataset['action'] === 'delete') {
      const ok = await confirmDialog({ title: 'Delete this line?', message: `“${line.text}” — old bills keep their own copy.`, confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      await deleteLine(id);
      await reload();
    }
  });

  render();
  return h('div', { class: 'lines-editor' }, summary, form, list);
}
