import { h } from '../dom';

export function mount(root: HTMLElement): void {
  root.append(
    h('header', { class: 'page-head' }, h('h1', { class: 'page-title', text: 'Settings' })),
    h('p', { class: 'muted', text: 'Coming soon.' }),
  );
}
