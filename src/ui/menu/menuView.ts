import { h, replaceChildren, rafBatch } from '../dom';
import { icon } from '../components/icons';
import { vegMark } from '../components/vegMark';
import { select, toggle } from '../components/form';
import { confirmDialog } from '../components/modal';
import { toast } from '../components/toast';
import { openDishForm } from './dishForm';
import { getMenu, refreshMenu, onMenuChange, searchDishes, type IndexedDish } from '../../state/menuStore';
import { setDishActive, deleteDish, addDishes } from '../../db/menuRepo';
import { SAMPLE_MENU } from '../../data/sampleMenu';
import { formatINR } from '../../core/money';
import { debounce } from '../../core/debounce';
import type { Cleanup } from '../../router';

export async function mount(root: HTMLElement): Promise<Cleanup> {
  let dishes: IndexedDish[] = await getMenu();
  let query = '';

  const count = h('span', { class: 'muted' });
  const addBtn = h('button', { class: 'btn btn-primary', attrs: { type: 'button' } }, icon('plus'), 'Add dish');
  const search = h('input', {
    class: 'input search-input',
    attrs: { type: 'search', placeholder: 'Search dishes…', 'aria-label': 'Search dishes', autocomplete: 'off' },
  });
  const catFilter = select([['', 'All categories']], '', { 'aria-label': 'Filter by category' });
  const statusFilter = select(
    [
      ['all', 'All dishes'],
      ['active', 'Available'],
      ['disabled', 'Disabled'],
    ],
    'all',
    { 'aria-label': 'Filter by availability' },
  );
  const list = h('ul', { class: 'dish-list', attrs: { 'aria-label': 'Dishes' } });
  const empty = h('div', { class: 'empty', attrs: { hidden: true } });

  root.append(
    h('header', { class: 'page-head' }, h('div', {}, h('h1', { class: 'page-title', text: 'Menu' }), count), addBtn),
    h('div', { class: 'toolbar' }, h('div', { class: 'search-wrap' }, icon('search', 18), search), catFilter, statusFilter),
    list,
    empty,
  );

  const categories = () => [...new Set(dishes.map((d) => d.category))].sort((a, b) => a.localeCompare(b));

  const renderCategories = () => {
    const cur = catFilter.value;
    replaceChildren(catFilter, h('option', { text: 'All categories', attrs: { value: '' } }), ...categories().map((c) => h('option', { text: c, attrs: { value: c } })));
    catFilter.value = categories().includes(cur) ? cur : '';
  };

  const row = (d: IndexedDish) =>
    h(
      'li',
      { class: `dish-row${d.active ? '' : ' is-disabled'}`, dataset: { id: String(d.id) } },
      vegMark(d.isVeg),
      h('div', { class: 'dish-main' }, h('span', { class: 'dish-name', text: d.name }), h('span', { class: 'dish-cat', text: d.category })),
      h('span', { class: 'dish-price', text: formatINR(d.pricePaise) }),
      toggle(`${d.name} available`, d.active, { 'data-action': 'toggle' }),
      h('button', { class: 'icon-btn', attrs: { type: 'button', 'data-action': 'edit', 'aria-label': `Edit ${d.name}` } }, icon('edit', 18)),
      h('button', { class: 'icon-btn icon-btn-danger', attrs: { type: 'button', 'data-action': 'delete', 'aria-label': `Delete ${d.name}` } }, icon('trash', 18)),
    );

  const render = rafBatch(() => {
    const cat = catFilter.value;
    const status = statusFilter.value;
    const shown = searchDishes(dishes, query).filter(
      (d) => (!cat || d.category === cat) && (status === 'all' || (status === 'active') === d.active),
    );
    count.textContent = ` ${dishes.length} dish${dishes.length === 1 ? '' : 'es'}`;
    replaceChildren(list, ...shown.map(row));
    list.hidden = shown.length === 0;
    empty.hidden = shown.length > 0;
    if (!shown.length) {
      if (dishes.length === 0) {
        const sample = h('button', { class: 'btn', text: 'Load sample menu (20 dishes)', attrs: { type: 'button' } });
        sample.addEventListener('click', async () => {
          sample.disabled = true;
          await addDishes(SAMPLE_MENU);
          await refreshMenu();
          toast('Sample menu added', 'success');
        });
        const add = h('button', { class: 'btn btn-primary', text: 'Add your first dish', attrs: { type: 'button' } });
        add.addEventListener('click', () => openDishForm(undefined, []));
        replaceChildren(empty, h('p', { class: 'empty-title', text: 'Your menu is empty' }), h('p', { class: 'muted', text: 'Add dishes one by one, or start with a sample menu you can edit.' }), h('div', { class: 'empty-actions' }, add, sample));
      } else {
        replaceChildren(empty, h('p', { class: 'empty-title', text: 'No dishes match' }), h('p', { class: 'muted', text: 'Try a different search or filter.' }));
      }
    }
  });

  const onSearch = debounce((q: string) => {
    query = q;
    render();
  }, 150);

  search.addEventListener('input', () => onSearch(search.value));
  catFilter.addEventListener('change', render);
  statusFilter.addEventListener('change', render);
  addBtn.addEventListener('click', () => openDishForm(undefined, categories()));

  // One delegated listener for every row button.
  list.addEventListener('click', async (e) => {
    const btn = (e.target as Element).closest<HTMLElement>('[data-action]');
    const li = btn?.closest<HTMLElement>('.dish-row');
    if (!btn || !li) return;
    const dish = dishes.find((d) => d.id === Number(li.dataset['id']));
    if (!dish) return;
    const action = btn.dataset['action'];
    if (action === 'edit') openDishForm(dish, categories());
    else if (action === 'toggle') {
      await setDishActive(dish.id, !dish.active);
      await refreshMenu();
    } else if (action === 'delete') {
      const ok = await confirmDialog({
        title: `Delete ${dish.name}?`,
        message: dish.usedInBills
          ? 'This dish appears in past bills, so it will be hidden from the menu but kept in old bills and reports.'
          : 'This dish has never been billed and will be removed permanently.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      const kind = await deleteDish(dish.id);
      await refreshMenu();
      toast(kind === 'soft' ? `${dish.name} hidden (kept in old bills)` : `${dish.name} deleted`, 'success');
    }
  });

  const off = onMenuChange((d) => {
    dishes = d;
    renderCategories();
    render();
  });

  renderCategories();
  render();
  return () => {
    off();
    onSearch.cancel();
  };
}
