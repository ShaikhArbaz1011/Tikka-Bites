import { h, replaceChildren } from '../dom';
import { icon } from '../components/icons';
import { field, textInput, select, segmented } from '../components/form';
import { toast } from '../components/toast';
import { linesEditor } from './linesEditor';
import { runBackup, runRestore } from './backupActions';
import { getSettings, saveSettings } from '../../db/settingsRepo';
import { countBills } from '../../db/backup';
import { refreshMenu } from '../../state/menuStore';
import { logoToDataUrl, LogoError } from '../../core/image';
import { formatDateTime } from '../../core/dates';
import * as v from '../../core/validate';
import type { ReceiptWidth } from '../../db/types';
import { BUILT_IN_LOGO } from '../../db/db';
import { getThemePref, setThemePref, type ThemePref } from '../../theme';

function section(title: string, desc: string, ...children: Node[]): HTMLElement {
  return h('section', { class: 'card settings-card' }, h('h2', { class: 'section-title', text: title }), h('p', { class: 'muted section-desc', text: desc }), ...children);
}

export async function mount(root: HTMLElement): Promise<() => void> {
  const s = await getSettings();

  // ---------- Restaurant details ----------
  const name = field('Restaurant name', textInput({ maxlength: v.LIMITS.restaurantName, required: true, value: s.name }));
  const addrInput = h('textarea', { class: 'input', attrs: { maxlength: v.LIMITS.address, rows: 3 } });
  addrInput.value = s.address;
  const address = field('Address', addrInput);
  const phone = field('Phone', textInput({ maxlength: v.LIMITS.phone, inputmode: 'tel', value: s.phone }));
  const currency = field('Currency symbol', textInput({ maxlength: v.LIMITS.currencySymbol, value: s.currencySymbol }));
  const width = field('Receipt paper', select([['58', '58 mm thermal'], ['80', '80 mm thermal'], ['A4', 'A4 sheet']], s.receiptWidth));
  const round = h('input', { attrs: { type: 'checkbox', id: 'set-round' } });
  round.checked = s.roundOff;
  const saveBtn = h('button', { class: 'btn btn-primary', text: 'Save details', attrs: { type: 'submit' } });
  const detailsForm = h(
    'form',
    { class: 'form-grid settings-grid', attrs: { novalidate: true } },
    name.wrap,
    phone.wrap,
    h('div', { class: 'span-2' }, address.wrap),
    currency.wrap,
    width.wrap,
    h('label', { class: 'check-row span-2', attrs: { for: 'set-round' } }, round, h('span', { text: 'Round bill totals to the nearest rupee' })),
    h('div', { class: 'span-2' }, saveBtn),
  );
  detailsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = v.text('Restaurant name', name.input.value, 1, v.LIMITS.restaurantName);
    const a = v.text('Address', address.input.value, 0, v.LIMITS.address, true);
    const p = v.phone(phone.input.value);
    const c = v.text('Currency symbol', currency.input.value, 1, v.LIMITS.currencySymbol);
    name.setError(n.ok ? null : n.error);
    address.setError(a.ok ? null : a.error);
    phone.setError(p.ok ? null : p.error);
    currency.setError(c.ok ? null : c.error);
    if (!n.ok || !a.ok || !p.ok || !c.ok) return;
    await saveSettings({ name: n.value, address: a.value, phone: p.value ?? '', currencySymbol: c.value, receiptWidth: width.input.value as ReceiptWidth, roundOff: round.checked });
    toast('Details saved', 'success');
  });

  // ---------- Logo ----------
  const logoBox = h('div', { class: 'logo-box' });
  const fileInput = h('input', { class: 'visually-hidden', attrs: { type: 'file', accept: 'image/png,image/jpeg,image/webp', id: 'logo-file' } });
  const uploadLabel = h('label', { class: 'btn', attrs: { for: 'logo-file' } }, icon('upload', 18), 'Upload a different logo');
  const removeBtn = h('button', { class: 'btn', text: 'Use Tikka Bites logo', attrs: { type: 'button' } });
  const printLogo = h('input', { attrs: { type: 'checkbox', id: 'set-print-logo' } });
  printLogo.checked = s.printLogo !== false;
  printLogo.addEventListener('change', async () => {
    await saveSettings({ printLogo: printLogo.checked });
    toast(printLogo.checked ? 'Logo will print on receipts' : 'Receipts will print without a logo', 'success');
  });
  let logo = s.logoDataUrl;
  const renderLogo = () => {
    replaceChildren(logoBox, h('img', { class: 'logo-img', attrs: { src: logo ?? BUILT_IN_LOGO, alt: logo ? 'Uploaded logo' : 'Tikka Bites logo' } }));
    removeBtn.hidden = !logo;
  };
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      logo = await logoToDataUrl(file);
      await saveSettings({ logoDataUrl: logo });
      renderLogo();
      toast('Logo updated', 'success');
    } catch (err) {
      toast(err instanceof LogoError ? err.message : 'Could not use this image', 'error', 5000);
    }
  });
  removeBtn.addEventListener('click', async () => {
    logo = undefined;
    await saveSettings({ logoDataUrl: undefined });
    renderLogo();
  });
  renderLogo();

  // ---------- Appearance ----------
  const theme = segmented('theme', 'Theme', [['system', 'Same as device'], ['light', 'Light'], ['dark', 'Dark']], getThemePref());
  theme.el.addEventListener('change', () => setThemePref(theme.get() as ThemePref));
  const onTheme = () => theme.set(getThemePref());
  document.addEventListener('themechange', onTheme);

  // ---------- Backup ----------
  const lastBackup = h('p', {});
  const storageStatus = h('p', { class: 'muted' });
  const renderBackupStatus = async () => {
    const cur = await getSettings();
    const bills = await countBills();
    lastBackup.textContent = cur.lastBackupAt
      ? `Last backup: ${formatDateTime(cur.lastBackupAt)} · ${bills.toLocaleString('en-IN')} bill${bills === 1 ? '' : 's'} on this device`
      : `No backup yet · ${bills.toLocaleString('en-IN')} bill${bills === 1 ? '' : 's'} on this device`;
  };
  const backupBtn = h('button', { class: 'btn btn-primary', attrs: { type: 'button' } }, icon('download', 18), 'Download backup');
  const restoreInput = h('input', { class: 'visually-hidden', attrs: { type: 'file', accept: 'application/json,.json', id: 'restore-file' } });
  const restoreLabel = h('label', { class: 'btn', attrs: { for: 'restore-file' } }, icon('upload', 18), 'Restore from backup');
  backupBtn.addEventListener('click', async () => {
    backupBtn.disabled = true;
    try {
      await runBackup();
      await renderBackupStatus();
    } finally {
      backupBtn.disabled = false;
    }
  });
  restoreInput.addEventListener('change', async () => {
    const file = restoreInput.files?.[0];
    restoreInput.value = '';
    if (file && (await runRestore(file))) {
      await refreshMenu();
      location.reload();
    }
  });
  void renderBackupStatus();
  void (async () => {
    const persisted = await navigator.storage?.persisted?.();
    storageStatus.textContent = persisted
      ? '✓ Storage is protected: the browser will not auto-delete your data.'
      : 'Storage is not yet protected. Install the app or keep using it and the browser may grant protection. Regular backups are still recommended.';
  })();

  root.append(
    h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: 'Settings' })),
    h(
      'div',
      { class: 'settings' },
      section('Restaurant details', 'Printed at the top of every receipt.', detailsForm),
      section('Receipt logo', 'The round Tikka Bites logo prints at the top of every receipt. You can upload a different PNG, JPG or WEBP (up to 2 MB); it is resized to 300px and stored on this device.',
        h('div', { class: 'logo-row' }, logoBox, h('div', { class: 'btn-row' }, fileInput, uploadLabel, removeBtn)),
        h('label', { class: 'check-row', attrs: { for: 'set-print-logo' } }, printLogo, h('span', { text: 'Print the logo on receipts' }))),
      section('Appearance', 'Tikka Bites colours: flame red on white (light) or on charcoal black (dark). Saved on this device.', theme.el),
      section('Receipt lines', 'Fun one-liners printed at the bottom of each receipt.', await linesEditor()),
      section(
        'Backup & restore',
        'All your data lives only in this browser. Download a backup regularly and keep it safe (e.g. email it to yourself or save to Google Drive).',
        lastBackup,
        h('div', { class: 'btn-row' }, backupBtn, restoreInput, restoreLabel),
        storageStatus,
      ),
    ),
  );
  return () => document.removeEventListener('themechange', onTheme);
}
