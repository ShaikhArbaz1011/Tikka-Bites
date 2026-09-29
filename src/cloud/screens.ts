/**
 * Full-screen gates shown before the app when the shared database is on:
 * sign in (User ID + password), fingerprint unlock, and first-time setup.
 * The app behind them is made inert, so nothing can be used until they finish.
 */
import '../styles/auth.css';
import { h } from '../ui/dom';
import { icon } from '../ui/components/icons';
import { assetUrl } from '../assets';
import { signIn } from './auth';
import { CloudError } from './errors';
import { biometricAvailable, enrollBiometric, verifyBiometric } from './biometric';

function gate(...children: Node[]): { el: HTMLElement; close(): void } {
  const app = document.getElementById('app');
  app?.setAttribute('inert', '');
  const el = h(
    'div',
    { class: 'auth-screen', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'auth-title' } },
    h(
      'div',
      { class: 'auth-card' },
      h('img', { class: 'auth-logo', attrs: { src: assetUrl('/brand/logo-round-300.webp'), alt: 'Tikka Bites', width: 120, height: 120 } }),
      ...children,
    ),
  );
  document.body.append(el);
  return {
    el,
    close() {
      el.remove();
      if (!document.querySelector('.auth-screen')) app?.removeAttribute('inert');
    },
  };
}

/** Sign-in form. Resolves once signed in. */
export function showSignIn(opts: { username?: string; message?: string } = {}): Promise<void> {
  return new Promise((resolve) => {
    const user = h('input', {
      class: 'input',
      attrs: { id: 'auth-user', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: 80, required: true, value: opts.username ?? '' },
    });
    const pass = h('input', { class: 'input', attrs: { id: 'auth-pass', type: 'password', autocomplete: 'current-password', maxlength: 200, required: true } });
    const show = h('button', { class: 'btn btn-ghost btn-sm', text: 'Show', attrs: { type: 'button', 'aria-controls': 'auth-pass', 'aria-pressed': 'false' } });
    show.addEventListener('click', () => {
      const visible = pass.type === 'password';
      pass.type = visible ? 'text' : 'password';
      show.textContent = visible ? 'Hide' : 'Show';
      show.setAttribute('aria-pressed', String(visible));
    });
    const err = h('p', { class: 'field-error', attrs: { role: 'alert', hidden: !opts.message } }, opts.message ?? '');
    const submit = h('button', { class: 'btn btn-primary auth-submit', text: 'Sign in', attrs: { type: 'submit' } });
    const form = h(
      'form',
      { class: 'auth-form', attrs: { novalidate: true } },
      h('div', { class: 'field' }, h('label', { class: 'field-label', text: 'User ID', attrs: { for: 'auth-user' } }), user),
      h('div', { class: 'field' }, h('label', { class: 'field-label', text: 'Password', attrs: { for: 'auth-pass' } }), h('div', { class: 'pass-row' }, pass, show)),
      err,
      submit,
    );
    const g = gate(
      h('h1', { class: 'auth-title', text: 'Sign in to Tikka Bites', attrs: { id: 'auth-title' } }),
      h('p', { class: 'muted auth-sub', text: 'Use the User ID and password the owner gave you.' }),
      form,
    );
    (opts.username ? pass : user).focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      submit.disabled = true;
      submit.textContent = 'Signing in…';
      try {
        await signIn(user.value, pass.value);
        g.close();
        resolve();
      } catch (ex) {
        err.textContent = ex instanceof CloudError ? ex.message : 'Could not sign in. Please try again.';
        err.hidden = false;
        pass.value = '';
        pass.focus();
      } finally {
        submit.disabled = false;
        submit.textContent = 'Sign in';
      }
    });
  });
}

/** Fingerprint lock. Resolves 'unlocked', or 'password' if they chose to sign in with the password. */
export function showLock(username: string): Promise<'unlocked' | 'password'> {
  return new Promise((resolve) => {
    const status = h('p', { class: 'muted auth-sub', attrs: { role: 'status' } }, 'Touch the fingerprint sensor to open the app.');
    const unlock = h('button', { class: 'btn btn-primary auth-submit', attrs: { type: 'button' } }, icon('fingerprint', 22), 'Unlock with fingerprint');
    const usePass = h('button', { class: 'btn btn-ghost', text: 'Use password instead', attrs: { type: 'button' } });
    const g = gate(h('h1', { class: 'auth-title', text: `Welcome back, ${username}`, attrs: { id: 'auth-title' } }), status, unlock, usePass);
    const tryUnlock = async () => {
      unlock.disabled = true;
      if (await verifyBiometric()) {
        g.close();
        resolve('unlocked');
        return;
      }
      status.textContent = 'Fingerprint not recognised. Try again, or use your password.';
      unlock.disabled = false;
      unlock.focus();
    };
    unlock.addEventListener('click', () => void tryUnlock());
    usePass.addEventListener('click', () => {
      g.close();
      resolve('password');
    });
    unlock.focus();
  });
}

/** After a password sign-in: offer fingerprint unlock (once per phone and account). */
export async function offerBiometric(username: string): Promise<void> {
  if (!(await biometricAvailable())) return;
  await new Promise<void>((resolve) => {
    const status = h('p', { class: 'muted auth-sub', attrs: { role: 'status' } }, 'Next time, open the app with your fingerprint instead of typing the password.');
    const yes = h('button', { class: 'btn btn-primary auth-submit', attrs: { type: 'button' } }, icon('fingerprint', 22), 'Use fingerprint');
    const no = h('button', { class: 'btn btn-ghost', text: 'Not now', attrs: { type: 'button' } });
    const g = gate(h('h1', { class: 'auth-title', text: 'Unlock with fingerprint?', attrs: { id: 'auth-title' } }), status, yes, no);
    yes.addEventListener('click', async () => {
      yes.disabled = true;
      try {
        await enrollBiometric(username);
        g.close();
        resolve();
      } catch {
        status.textContent = 'Fingerprint was not set up. You can turn it on later in Settings.';
        yes.disabled = false;
      }
    });
    no.addEventListener('click', () => {
      g.close();
      resolve();
    });
    yes.focus();
  });
}

/** A blocking message with one or two actions (first-time setup, joining, errors). */
export function showNotice(opts: { title: string; body: string; primary: string; secondary?: string; busy?: string }): Promise<'primary' | 'secondary'> & { setStatus(t: string): void } {
  const status = h('p', { class: 'muted auth-sub', attrs: { role: 'status' } }, opts.body);
  const primary = h('button', { class: 'btn btn-primary auth-submit', text: opts.primary, attrs: { type: 'button' } });
  const secondary = opts.secondary ? h('button', { class: 'btn btn-ghost', text: opts.secondary, attrs: { type: 'button' } }) : null;
  const g = gate(h('h1', { class: 'auth-title', text: opts.title, attrs: { id: 'auth-title' } }), status, primary, ...(secondary ? [secondary] : []));
  const p = new Promise<'primary' | 'secondary'>((resolve) => {
    primary.addEventListener('click', () => {
      g.close();
      resolve('primary');
    });
    secondary?.addEventListener('click', () => {
      g.close();
      resolve('secondary');
    });
  }) as Promise<'primary' | 'secondary'> & { setStatus(t: string): void };
  p.setStatus = (t) => (status.textContent = t);
  primary.focus();
  return p;
}

/** A blocking "please wait" screen with a progress line; close() when done. */
export function showBusy(title: string, body: string): { set(text: string): void; close(): void } {
  const status = h('p', { class: 'muted auth-sub', attrs: { role: 'status' } }, body);
  const g = gate(h('h1', { class: 'auth-title', text: title, attrs: { id: 'auth-title' } }), h('div', { class: 'auth-spinner', attrs: { 'aria-hidden': 'true' } }), status);
  return { set: (t) => (status.textContent = t), close: g.close };
}
