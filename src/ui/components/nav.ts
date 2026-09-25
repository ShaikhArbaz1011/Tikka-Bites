import { h } from '../dom';
import { icon } from './icons';
import { ROUTES, type RouteName } from '../../router';

/** Renders the nav once; returns a function that marks the active route. */
export function renderNav(nav: HTMLElement): (active: RouteName) => void {
  const links = new Map<RouteName, HTMLAnchorElement>();
  const brand = h('div', { class: 'nav-brand' }, h('span', { class: 'nav-logo', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'nav-brand-text', text: 'RestoBill' }));
  const list = h('ul', { class: 'nav-list' });
  for (const [name, r] of Object.entries(ROUTES) as [RouteName, (typeof ROUTES)[RouteName]][]) {
    const a = h('a', { class: 'nav-link', attrs: { href: `#/${name}` } }, icon(r.icon), h('span', { class: 'nav-label', text: r.label }));
    links.set(name, a);
    list.append(h('li', {}, a));
  }
  nav.replaceChildren(brand, list);

  return (active) => {
    for (const [name, a] of links) {
      if (name === active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  };
}
