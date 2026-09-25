import { h } from '../dom';
import { assetUrl } from '../../assets';

/** Dish photo (lazy-loaded), or a lettered tile when the dish has none. Decorative: the name is shown next to it. */
export function dishPhoto(src: string | undefined, name: string, cls: string): HTMLElement {
  if (src) {
    return h('img', { class: cls, attrs: { src: assetUrl(src), alt: '', loading: 'lazy', decoding: 'async', width: 400, height: 300, draggable: 'false' } });
  }
  return h('span', { class: `${cls} no-photo`, text: name.trim().charAt(0).toUpperCase(), attrs: { 'aria-hidden': 'true' } });
}
