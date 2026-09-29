/**
 * Settings → Users (shared database, super admin only): who can sign in, add a user,
 * change a password, remove a user. Hidden for everyone else; the database checks
 * the role again on every change (supabase/functions/staff-admin).
 */
import '../styles/auth.css';
import { h, replaceChildren } from '../ui/dom';
import { field, textInput, type Field } from '../ui/components/form';
import { confirmDialog, openModal } from '../ui/components/modal';
import { toast } from '../ui/components/toast';
import * as v from '../core/validate';
import { api, type StaffRow } from './api';
import { CloudError } from './errors';

type Section = (title: string, desc: string, ...children: Node[]) => HTMLElement;

const why = (e: unknown) => (e instanceof CloudError ? e.message : 'Something went wrong. Please try again.');

let seq = 0;
/** Password field with a Show / Hide button. */
function passwordField(label: string, hint?: string): Field<HTMLInputElement> {
  const id = `user-pass-${++seq}`;
  const input = h('input', { class: 'input', attrs: { id, type: 'password', autocomplete: 'new-password', maxlength: 72 } });
  const f = field(label, input, hint);
  const show = h('button', { class: 'btn btn-ghost btn-sm', text: 'Show', attrs: { type: 'button', 'aria-controls': id, 'aria-pressed': 'false' } });
  show.addEventListener('click', () => {
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    show.textContent = visible ? 'Hide' : 'Show';
    show.setAttribute('aria-pressed', String(visible));
  });
  const row = h('div', { class: 'pass-row' });
  f.wrap.insertBefore(row, input);
  row.append(input, show);
  return f;
}

function changePassword(username: string, me: boolean): void {
  const pass = passwordField('New password', 'At least 8 characters');
  const save = h('button', { class: 'btn btn-primary', text: 'Save password', attrs: { type: 'submit', form: 'user-pass-form' } });
  const cancel = h('button', { class: 'btn', text: 'Cancel', attrs: { type: 'button' } });
  const form = h('form', { class: 'form-grid', attrs: { id: 'user-pass-form', novalidate: true } }, pass.wrap);
  const m = openModal({ title: me ? 'Change your password' : `New password for ${username}`, body: form, actions: [cancel, save] });
  cancel.addEventListener('click', m.close);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = v.newPassword(pass.input.value);
    pass.setError(p.ok ? null : p.error);
    if (!p.ok) return;
    save.disabled = true;
    try {
      await api.staffAdmin('reset', username, p.value);
      m.close();
      toast(me ? 'Your password was changed' : `Password changed for ${username}`, 'success');
    } catch (err) {
      pass.setError(why(err));
    } finally {
      save.disabled = false;
    }
  });
  pass.input.focus();
}

export function usersSection(section: Section): HTMLElement {
  const list = h('ul', { class: 'user-list', attrs: { 'aria-label': 'People who can sign in' } });
  const status = h('p', { class: 'muted', attrs: { role: 'status' } });

  const user = field('User ID', textInput({ maxlength: 30, autocapitalize: 'none', spellcheck: 'false' }), 'Small letters, numbers, dot, dash or underscore, e.g. counter2');
  const pass = passwordField('Password', 'At least 8 characters. Give it to the person along with the User ID.');
  const add = h('button', { class: 'btn btn-primary', text: 'Add user', attrs: { type: 'submit' } });
  const form = h('form', { class: 'form-grid', attrs: { novalidate: true, 'aria-label': 'Add a user' } }, user.wrap, pass.wrap, h('div', { class: 'btn-row' }, add));

  const el = section(
    'Users',
    'Only you, the super admin, see this. Add the people who may sign in, change a password, or remove someone.',
    list,
    status,
    h('h3', { class: 'users-sub', text: 'Add a user' }),
    form,
  );
  el.hidden = true;

  let rows: StaffRow[] = [];
  const row = (r: StaffRow) => {
    const name = r.username ?? '(signs in with email)';
    const role = `${r.role === 'super_admin' ? 'Super admin' : 'Staff'}${r.me ? ' · you' : ''}`;
    const actions = h('div', { class: 'btn-row' });
    if (r.username && (r.role === 'staff' || r.me)) {
      actions.append(h('button', { class: 'btn btn-sm', text: r.me ? 'Change my password' : 'Change password', attrs: { type: 'button', 'data-action': 'reset', 'data-user': r.username } }));
    }
    if (r.username && r.role === 'staff' && !r.me) {
      actions.append(h('button', { class: 'btn btn-sm btn-danger', text: 'Remove', attrs: { type: 'button', 'data-action': 'remove', 'data-user': r.username } }));
    }
    return h('li', { class: 'user-row' }, h('span', { class: 'user-name', text: name }), h('span', { class: 'user-role', text: role }), actions);
  };
  const load = async () => {
    rows = await api.listStaff();
    replaceChildren(list, ...rows.map(row));
  };

  // One listener for every row (event delegation).
  list.addEventListener('click', async (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button[data-action]') : null;
    const name = btn?.getAttribute('data-user');
    if (!btn || !name) return;
    const me = rows.some((r) => r.me && r.username === name);
    if (btn.getAttribute('data-action') === 'reset') return changePassword(name, me);
    const ok = await confirmDialog({
      title: `Remove ${name}?`,
      message: `${name} can no longer sign in, on any phone. Bills they made stay.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.staffAdmin('remove', name);
      toast(`${name} was removed`, 'success');
      await load();
    } catch (err) {
      toast(why(err), 'error', 6000);
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = v.userId(user.input.value);
    const p = v.newPassword(pass.input.value);
    user.setError(u.ok ? null : u.error);
    pass.setError(p.ok ? null : p.error);
    if (!u.ok || !p.ok) return;
    add.disabled = true;
    status.textContent = `Adding ${u.value}…`;
    try {
      await api.staffAdmin('add', u.value, p.value);
      form.reset();
      status.textContent = '';
      toast(`${u.value} can now sign in`, 'success');
      await load();
    } catch (err) {
      status.textContent = '';
      const msg = why(err);
      if (/User ID/.test(msg)) user.setError(msg);
      else if (/password/i.test(msg)) pass.setError(msg);
      else status.textContent = msg;
    } finally {
      add.disabled = false;
    }
  });

  // Shown only to the super admin (needs the internet to ask the database).
  void (async () => {
    try {
      if ((await api.myRole()) !== 'super_admin') return;
      await load();
      el.hidden = false;
    } catch {
      // offline or not allowed: stays hidden
    }
  })();
  return el;
}
