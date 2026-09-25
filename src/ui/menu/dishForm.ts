import { h } from '../dom';
import { openModal } from '../components/modal';
import { field, textInput, segmented } from '../components/form';
import { toast } from '../components/toast';
import { addDish, updateDish, MenuError, type DishInput } from '../../db/menuRepo';
import { refreshMenu } from '../../state/menuStore';
import * as v from '../../core/validate';
import { paiseToDecimal } from '../../core/money';
import type { Dish } from '../../db/types';

/** Open the add/edit dish dialog. Resolves once the dialog closes. */
export function openDishForm(existing: Dish | undefined, categories: string[]): void {
  const name = field('Dish name', textInput({ maxlength: v.LIMITS.dishName, required: true, value: existing?.name ?? '' }));
  const listId = 'cat-options';
  const category = field(
    'Category',
    textInput({ maxlength: v.LIMITS.category, required: true, list: listId, value: existing?.category ?? '' }),
    'Pick one or type a new category',
  );
  const datalist = h('datalist', { attrs: { id: listId } }, ...categories.map((c) => h('option', { attrs: { value: c } })));
  const price = field(
    'Price (₹)',
    textInput({ inputmode: 'decimal', required: true, placeholder: 'e.g. 249 or 99.50', value: existing ? paiseToDecimal(existing.pricePaise) : '' }),
  );
  const veg = segmented('veg', 'Food type', [['veg', 'Veg'], ['nonveg', 'Non-veg']], existing && !existing.isVeg ? 'nonveg' : 'veg');
  const active = h('input', { attrs: { type: 'checkbox', id: 'dish-active' } });
  active.checked = existing?.active ?? true;
  const activeRow = h('label', { class: 'check-row', attrs: { for: 'dish-active' } }, active, h('span', { text: 'Available for billing' }));

  const save = h('button', { class: 'btn btn-primary', text: existing ? 'Save changes' : 'Add dish', attrs: { type: 'submit', form: 'dish-form' } });
  const cancel = h('button', { class: 'btn', text: 'Cancel', attrs: { type: 'button' } });

  const form = h(
    'form',
    { class: 'form-grid', attrs: { id: 'dish-form', novalidate: true } },
    name.wrap,
    category.wrap,
    datalist,
    price.wrap,
    h('div', { class: 'field' }, h('span', { class: 'field-label', text: 'Type' }), veg.el),
    activeRow,
  );

  const m = openModal({ title: existing ? 'Edit dish' : 'Add dish', body: form, actions: [cancel, save] });
  cancel.addEventListener('click', m.close);
  name.input.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = v.text('Name', name.input.value, 1, v.LIMITS.dishName);
    const c = v.text('Category', category.input.value, 1, v.LIMITS.category);
    const p = v.price(price.input.value);
    name.setError(n.ok ? null : n.error);
    category.setError(c.ok ? null : c.error);
    price.setError(p.ok ? null : p.error);
    if (!n.ok || !c.ok || !p.ok) {
      (!n.ok ? name : !c.ok ? category : price).input.focus();
      return;
    }
    const input: DishInput = { name: n.value, category: c.value, pricePaise: p.value, isVeg: veg.get() === 'veg', active: active.checked };
    save.disabled = true;
    try {
      if (existing) await updateDish(existing.id, input);
      else await addDish(input);
      await refreshMenu();
      toast(existing ? 'Dish updated' : `${input.name} added`, 'success');
      m.close();
    } catch (err) {
      toast(err instanceof MenuError ? err.message : 'Could not save the dish', 'error');
      save.disabled = false;
    }
  });
}
