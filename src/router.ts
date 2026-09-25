/**
 * Hash router. Each route lazily resolves to a view module with a `mount` function
 * that renders into the <main> element and returns an optional cleanup callback.
 * Billing is the landing screen, so it is bundled eagerly; the others are split chunks.
 */

import * as billingView from './ui/billing/billingView';

export type Cleanup = () => void;
export interface ViewModule {
  mount(root: HTMLElement): Cleanup | void | Promise<Cleanup | void>;
}

export const ROUTES = {
  billing: { label: 'Billing', icon: 'bill', load: () => Promise.resolve(billingView) },
  menu: { label: 'Menu', icon: 'menu', load: () => import('./ui/menu/menuView') },
  reports: { label: 'Reports', icon: 'chart', load: () => import('./ui/reports/reportsView') },
  settings: { label: 'Settings', icon: 'settings', load: () => import('./ui/settings/settingsView') },
} as const;

export type RouteName = keyof typeof ROUTES;
export const DEFAULT_ROUTE: RouteName = 'billing';

export function currentRoute(): RouteName {
  const name = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  return name in ROUTES ? (name as RouteName) : DEFAULT_ROUTE;
}

export function startRouter(root: HTMLElement, onChange: (r: RouteName) => void): void {
  let cleanup: Cleanup | void;
  let token = 0;

  const render = async () => {
    const name = currentRoute();
    const my = ++token;
    onChange(name);
    if (cleanup) cleanup();
    cleanup = undefined;
    root.replaceChildren();
    root.setAttribute('aria-busy', 'true');
    try {
      const mod: ViewModule = await ROUTES[name].load();
      if (my !== token) return; // a newer navigation won the race
      cleanup = await mod.mount(root);
    } finally {
      if (my === token) root.removeAttribute('aria-busy');
    }
  };

  window.addEventListener('hashchange', () => void render());
  void render();
}
