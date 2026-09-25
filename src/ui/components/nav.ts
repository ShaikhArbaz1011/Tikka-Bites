import { h } from '../dom';
import { assetUrl } from '../../assets';
import { icon, type IconName } from './icons';
import { ROUTES, type RouteName } from '../../router';
import { getThemePref, setThemePref, type ThemePref } from '../../theme';

const THEME_NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_ICON: Record<ThemePref, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' };
const THEME_LABEL: Record<ThemePref, string> = { system: 'Theme: device', light: 'Theme: light', dark: 'Theme: dark' };

/** Button that cycles device → light → dark. Several can exist; they stay in sync. */
export function themeToggle(extraClass = ''): HTMLButtonElement {
  const btn = h('button', { class: `theme-toggle ${extraClass}`, attrs: { type: 'button' } });
  const paint = () => {
    const pref = getThemePref();
    btn.replaceChildren(icon(THEME_ICON[pref], 18), h('span', { class: 'theme-label', text: THEME_LABEL[pref] }));
    btn.setAttribute('aria-label', `${THEME_LABEL[pref]}. Switch to ${THEME_LABEL[THEME_NEXT[pref]].replace('Theme: ', '')}`);
    btn.title = THEME_LABEL[pref];
  };
  btn.addEventListener('click', () => setThemePref(THEME_NEXT[getThemePref()]));
  document.addEventListener('themechange', paint);
  paint();
  return btn;
}

/** Renders the nav (and the phone top bar) once; returns a function that marks the active route. */
export function renderNav(nav: HTMLElement, topbar: HTMLElement): (active: RouteName) => void {
  const links = new Map<RouteName, HTMLAnchorElement>();
  const brand = h(
    'a',
    { class: 'nav-brand', attrs: { href: '#/billing', 'aria-label': 'Tikka Bites home' } },
    h('img', { class: 'brand-round', attrs: { src: assetUrl('/brand/logo-round-96.webp'), alt: '', width: 48, height: 48 } }),
    h('span', { class: 'brand-wide-wrap' }, h('img', { class: 'brand-wide', attrs: { src: assetUrl('/brand/logo-wide.webp'), alt: '', width: 491, height: 120 } })),
  );
  const list = h('ul', { class: 'nav-list' });
  for (const [name, r] of Object.entries(ROUTES) as [RouteName, (typeof ROUTES)[RouteName]][]) {
    const a = h('a', { class: 'nav-link', attrs: { href: `#/${name}` } }, icon(r.icon), h('span', { class: 'nav-label', text: r.label }));
    links.set(name, a);
    list.append(h('li', {}, a));
  }
  nav.replaceChildren(brand, list, h('div', { class: 'nav-foot' }, themeToggle('nav-theme')));

  topbar.replaceChildren(
    h('img', { class: 'topbar-logo', attrs: { src: assetUrl('/brand/logo-round-96.webp'), alt: '', width: 36, height: 36 } }),
    h('span', { class: 'topbar-name' }, h('span', { class: 'tb-white', text: 'TIKKA ' }), h('span', { class: 'tb-red', text: 'BITES' })),
    themeToggle('topbar-theme icon-only'),
  );

  return (active) => {
    for (const [name, a] of links) {
      if (name === active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  };
}
