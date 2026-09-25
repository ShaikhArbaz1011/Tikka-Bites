import { h } from '../dom';

/** Indian food-label style mark: green square+dot (veg) or red square+triangle (non-veg). */
export function vegMark(isVeg: boolean): HTMLSpanElement {
  return h('span', {
    class: `veg-mark ${isVeg ? 'is-veg' : 'is-nonveg'}`,
    attrs: { role: 'img', 'aria-label': isVeg ? 'Veg' : 'Non-veg', title: isVeg ? 'Veg' : 'Non-veg' },
  });
}
