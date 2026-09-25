import { h, replaceChildren, rafBatch } from '../dom';
import { icon } from '../components/icons';
import { vegMark } from '../components/vegMark';
import { segmented, textInput } from '../components/form';
import { toast } from '../components/toast';
import { Cart, parseDraft } from './cartState';
import { getMenu, onMenuChange, searchDishes, type IndexedDish } from '../../state/menuStore';
import { getSettings, getMeta, setMeta } from '../../db/settingsRepo';
import { saveBill, BillError } from '../../db/billRepo';
import { computeTotals, NO_DISCOUNT, type Discount } from '../../core/totals';
import { formatINR } from '../../core/money';
import { debounce } from '../../core/debounce';
import * as v from '../../core/validate';
import type { OrderType, PaymentMode, Settings } from '../../db/types';
import type { Cleanup } from '../../router';

export async function mount(root: HTMLElement): Promise<Cleanup> {
  const [initialMenu, initialSettings, draft] = await Promise.all([getMenu(), getSettings(), getMeta('cartDraft')]);
  const settings: Settings = initialSettings;
  let menu = initialMenu.filter((d) => d.active);
  let byId = new Map(menu.map((d) => [d.id, d]));
  const cart = new Cart();
  const restored = parseDraft(draft, new Set(byId.keys()));
  if (restored) cart.data = restored;

  const money = (p: number) => formatINR(p, settings.currencySymbol);

  // ---------- Menu side ----------
  const search = h('input', {
    class: 'input search-input',
    attrs: {
      type: 'search',
      placeholder: 'Search dishes…  ( / )',
      'aria-label': 'Search dishes',
      autocomplete: 'off',
      'aria-keyshortcuts': '/',
    },
  });
  const chips = h('div', { class: 'chips', attrs: { role: 'toolbar', 'aria-label': 'Categories' } });
  const grid = h('div', { class: 'dish-grid', attrs: { 'aria-label': 'Dishes' } });
  const gridEmpty = h('div', { class: 'empty', attrs: { hidden: true } });

  // ---------- Bill panel ----------
  const orderType = segmented('orderType', 'Order type', [['dine-in', 'Dine-in'], ['takeaway', 'Takeaway'], ['delivery', 'Delivery']], cart.data.orderType);
  const tableNo = textInput({ maxlength: v.LIMITS.tableNo, placeholder: 'Table no.', 'aria-label': 'Table number', inputmode: 'numeric', value: cart.data.tableNo });
  const lines = h('ul', { class: 'cart-lines', attrs: { 'aria-label': 'Items in bill' } });
  const linesEmpty = h('p', { class: 'cart-empty muted', text: 'Tap a dish to add it to the bill.' });

  const discKind = segmented('discKind', 'Discount type', [['flat', '₹'], ['pct', '%']], cart.data.discountKind);
  const discInput = textInput({ inputmode: 'decimal', placeholder: '0', 'aria-label': 'Discount', value: cart.data.discountInput, maxlength: 12 });
  const discError = h('p', { class: 'field-error', attrs: { hidden: true, id: 'disc-err' } });
  discInput.setAttribute('aria-describedby', 'disc-err');
  const customer = textInput({ maxlength: v.LIMITS.customerName, placeholder: 'Customer name (optional)', 'aria-label': 'Customer name', value: cart.data.customerName });
  const payment = segmented('payment', 'Payment mode', [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card']], cart.data.paymentMode);

  const tSubtotal = h('dd', {});
  const tDiscount = h('dd', {});
  const tRound = h('dd', {});
  const tTotal = h('dd', { class: 'total-value' });
  const rowDiscount = h('div', { class: 'trow' }, h('dt', { text: 'Discount' }), tDiscount);
  const rowRound = h('div', { class: 'trow' }, h('dt', { text: 'Round off' }), tRound);
  const totals = h(
    'dl',
    { class: 'totals' },
    h('div', { class: 'trow' }, h('dt', { text: 'Subtotal' }), tSubtotal),
    rowDiscount,
    rowRound,
    h('div', { class: 'trow trow-total' }, h('dt', { text: 'Total' }), tTotal),
  );

  const saveBtn = h('button', { class: 'btn', attrs: { type: 'button' } }, 'Save');
  const printBtn = h('button', { class: 'btn btn-primary', attrs: { type: 'button', 'aria-keyshortcuts': 'Control+P' } }, icon('print', 18), 'Save & Print');
  const clearBtn = h('button', { class: 'btn btn-ghost btn-sm', text: 'Clear', attrs: { type: 'button' } });
  const closeSheet = h('button', { class: 'icon-btn sheet-close', attrs: { type: 'button', 'aria-label': 'Back to menu' } }, icon('x'));

  const panel = h(
    'aside',
    { class: 'bill-panel', attrs: { 'aria-label': 'Current bill', id: 'bill-panel' } },
    h('div', { class: 'panel-head' }, h('h2', { class: 'panel-title', text: 'Current bill' }), clearBtn, closeSheet),
    h('div', { class: 'panel-scroll' },
      h('div', { class: 'panel-row' }, orderType.el, tableNo),
      lines,
      linesEmpty,
      h('div', { class: 'panel-section' },
        h('div', { class: 'disc-row' }, h('span', { class: 'field-label', text: 'Discount' }), discKind.el, discInput),
        discError,
        customer,
        h('div', { class: 'pay-row' }, h('span', { class: 'field-label', text: 'Payment' }), payment.el),
      ),
    ),
    h('div', { class: 'panel-foot' }, totals, h('div', { class: 'panel-actions' }, saveBtn, printBtn)),
  );

  const barCount = h('span', { class: 'cart-bar-count' });
  const barTotal = h('span', { class: 'cart-bar-total' });
  const cartBar = h('button', { class: 'cart-bar', attrs: { type: 'button', 'aria-controls': 'bill-panel', hidden: true } },
    icon('cart'), barCount, barTotal, h('span', { class: 'cart-bar-cta', text: 'View bill →' }));

  root.append(
    h('div', { class: 'billing' },
      h('section', { class: 'bill-menu', attrs: { 'aria-label': 'Menu' } },
        h('div', { class: 'search-wrap' }, icon('search', 18), search),
        chips,
        grid,
        gridEmpty,
      ),
      panel,
      cartBar,
    ),
  );

  // ---------- Menu grid (cards built once, filtered by toggling `hidden`) ----------
  const cards = new Map<number, { el: HTMLButtonElement; badge: HTMLSpanElement }>();
  let category = '';
  let query = '';
  let visible: number[] = [];
  let highlight = -1;

  const buildGrid = () => {
    cards.clear();
    const els = menu.map((d) => {
      const badge = h('span', { class: 'qty-badge', attrs: { hidden: true } });
      const el = h('button', { class: 'dish-card', dataset: { id: String(d.id) }, attrs: { type: 'button' } },
        h('span', { class: 'dish-card-top' }, vegMark(d.isVeg), badge),
        h('span', { class: 'dish-card-name', text: d.name }),
        h('span', { class: 'dish-card-price', text: money(d.pricePaise) }),
      );
      cards.set(d.id, { el, badge });
      return el;
    });
    replaceChildren(grid, ...els);
    const cats = [...new Set(menu.map((d) => d.category))];
    if (category && !cats.includes(category)) category = '';
    replaceChildren(chips, ...['', ...cats].map((c) =>
      h('button', { class: 'chip', text: c || 'All', dataset: { cat: c }, attrs: { type: 'button', 'aria-pressed': String(c === category) } })));
    for (const l of cart.data.lines) updateBadge(l.menuId);
    applyFilter();
  };

  const applyFilter = () => {
    const matches = new Set(searchDishes(menu, query).filter((d: IndexedDish) => !category || d.category === category).map((d) => d.id));
    visible = [];
    for (const d of menu) {
      const show = matches.has(d.id);
      cards.get(d.id)!.el.hidden = !show;
      if (show) visible.push(d.id);
    }
    setHighlight(query ? 0 : -1);
    grid.hidden = visible.length === 0;
    gridEmpty.hidden = visible.length > 0;
    if (!visible.length) {
      if (menu.length === 0) {
        replaceChildren(gridEmpty, h('p', { class: 'empty-title', text: 'No dishes to bill yet' }), h('p', { class: 'muted', text: 'Add dishes to your menu first.' }),
          h('a', { class: 'btn btn-primary', text: 'Go to Menu', attrs: { href: '#/menu' } }));
      } else {
        replaceChildren(gridEmpty, h('p', { class: 'empty-title', text: 'No dishes match' }), h('p', { class: 'muted', text: 'Try another search or category.' }));
      }
    }
  };

  let highlightedId: number | undefined;
  const setHighlight = (i: number) => {
    if (highlightedId !== undefined) cards.get(highlightedId)?.el.classList.remove('is-highlighted');
    highlight = visible.length ? Math.max(-1, Math.min(i, visible.length - 1)) : -1;
    highlightedId = visible[highlight];
    if (highlightedId !== undefined) {
      const el = cards.get(highlightedId)!.el;
      el.classList.add('is-highlighted');
      el.scrollIntoView({ block: 'nearest' });
    }
  };

  const updateBadge = (id: number) => {
    const c = cards.get(id);
    if (!c) return;
    const q = cart.qtyOf(id);
    c.badge.textContent = String(q);
    c.badge.hidden = q === 0;
    c.el.classList.toggle('in-cart', q > 0);
    c.el.setAttribute('aria-label', `${byId.get(id)?.name ?? ''}, ${money(byId.get(id)?.pricePaise ?? 0)}${q ? `, ${q} in bill` : ''}`);
  };

  // ---------- Bill rendering ----------
  let discountOk = true;
  const currentDiscount = (): Discount => {
    const raw = discInput.value.trim();
    const res = cart.data.discountKind === 'pct' ? v.discountPercent(raw || '0') : v.discountFlat(raw);
    discountOk = res.ok;
    discError.textContent = res.ok ? '' : res.error;
    discError.hidden = res.ok;
    if (res.ok) discInput.removeAttribute('aria-invalid');
    else discInput.setAttribute('aria-invalid', 'true');
    if (!res.ok) return NO_DISCOUNT;
    return cart.data.discountKind === 'pct' ? { kind: 'pct', bp: res.value } : { kind: 'flat', paise: res.value };
  };

  const lineEl = (menuId: number, qty: number) => {
    const d = byId.get(menuId);
    if (!d) return null;
    const qtyInput = h('input', { class: 'qty-input', attrs: { type: 'text', inputmode: 'numeric', 'aria-label': `Quantity of ${d.name}`, maxlength: 3, 'data-action': 'qty' } });
    qtyInput.value = String(qty);
    return h('li', { class: 'cart-line', dataset: { id: String(menuId) } },
      h('div', { class: 'cart-line-main' },
        h('span', { class: 'cart-line-name', text: d.name }),
        h('span', { class: 'cart-line-unit muted', text: money(d.pricePaise) })),
      h('div', { class: 'stepper' },
        h('button', { class: 'step-btn', attrs: { type: 'button', 'data-action': 'dec', 'aria-label': `One less ${d.name}` } }, icon('minus', 16)),
        qtyInput,
        h('button', { class: 'step-btn', attrs: { type: 'button', 'data-action': 'inc', 'aria-label': `One more ${d.name}` } }, icon('plus', 16))),
      h('span', { class: 'cart-line-total', text: money(d.pricePaise * qty) }),
    );
  };

  const renderBill = rafBatch(() => {
    const items = cart.data.lines.filter((l) => byId.has(l.menuId));
    replaceChildren(lines, ...items.map((l) => lineEl(l.menuId, l.qty)));
    lines.hidden = items.length === 0;
    linesEmpty.hidden = items.length > 0;
    tableNo.hidden = cart.data.orderType !== 'dine-in';

    const t = computeTotals(items.map((l) => ({ unitPaise: byId.get(l.menuId)!.pricePaise, qty: l.qty })), currentDiscount(), settings.roundOff);
    tSubtotal.textContent = money(t.subtotalPaise);
    tDiscount.textContent = `−${money(t.discountPaise)}`;
    rowDiscount.hidden = t.discountPaise === 0;
    tRound.textContent = `${t.roundOffPaise < 0 ? '−' : '+'}${money(Math.abs(t.roundOffPaise))}`;
    rowRound.hidden = t.roundOffPaise === 0;
    tTotal.textContent = money(t.totalPaise);

    const empty = items.length === 0;
    saveBtn.disabled = printBtn.disabled = empty || !discountOk;
    clearBtn.hidden = empty;
    cartBar.hidden = empty;
    barCount.textContent = `${t.itemCount} item${t.itemCount === 1 ? '' : 's'}`;
    barTotal.textContent = money(t.totalPaise);
    if (empty) panel.classList.remove('is-open');
  });

  const persist = debounce(() => void setMeta('cartDraft', cart.data), 300);
  const offCart = cart.subscribe((changedId) => {
    if (changedId !== undefined) updateBadge(changedId);
    renderBill();
    persist();
  });

  // ---------- Events (delegated) ----------
  grid.addEventListener('click', (e) => {
    const card = (e.target as Element).closest<HTMLElement>('.dish-card');
    if (card) cart.add(Number(card.dataset['id']));
  });
  chips.addEventListener('click', (e) => {
    const chip = (e.target as Element).closest<HTMLElement>('.chip');
    if (!chip) return;
    category = chip.dataset['cat'] ?? '';
    for (const c of chips.children) c.setAttribute('aria-pressed', String((c as HTMLElement).dataset['cat'] === category));
    applyFilter();
  });
  const onSearch = debounce((q: string) => {
    query = q;
    applyFilter();
  }, 150);
  search.addEventListener('input', () => onSearch(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(highlight + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onSearch.cancel();
      if (query !== search.value) {
        query = search.value;
        applyFilter();
      }
      const id = visible[Math.max(0, highlight)];
      if (id !== undefined) {
        cart.add(id);
        toast(`${byId.get(id)!.name} added`, 'info', 1200);
      }
    } else if (e.key === 'Escape') {
      search.value = '';
      query = '';
      applyFilter();
    }
  });

  lines.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLElement>('[data-action]');
    const id = Number(btn?.closest<HTMLElement>('.cart-line')?.dataset['id']);
    if (!btn || !id) return;
    if (btn.dataset['action'] === 'inc') cart.add(id);
    else if (btn.dataset['action'] === 'dec') cart.decrement(id);
  });
  lines.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.dataset['action'] !== 'qty') return;
    const id = Number(input.closest<HTMLElement>('.cart-line')?.dataset['id']);
    const res = v.qty(input.value);
    if (res.ok) cart.setQty(id, res.value);
    else {
      toast(res.error, 'error');
      input.value = String(cart.qtyOf(id));
    }
  });
  lines.addEventListener('focusin', (e) => {
    if ((e.target as HTMLElement).dataset['action'] === 'qty') (e.target as HTMLInputElement).select();
  });

  orderType.el.addEventListener('change', () => cart.set('orderType', orderType.get() as OrderType));
  payment.el.addEventListener('change', () => cart.set('paymentMode', payment.get() as PaymentMode));
  discKind.el.addEventListener('change', () => cart.set('discountKind', discKind.get() as 'flat' | 'pct'));
  discInput.addEventListener('input', () => cart.set('discountInput', discInput.value));
  tableNo.addEventListener('input', () => cart.set('tableNo', tableNo.value));
  customer.addEventListener('input', () => cart.set('customerName', customer.value));
  clearBtn.addEventListener('click', () => {
    cart.reset();
    syncInputs();
  });
  cartBar.addEventListener('click', () => {
    panel.classList.add('is-open');
    closeSheet.focus();
  });
  closeSheet.addEventListener('click', () => {
    panel.classList.remove('is-open');
    cartBar.focus();
  });

  const syncInputs = () => {
    orderType.set(cart.data.orderType);
    payment.set(cart.data.paymentMode);
    discKind.set(cart.data.discountKind);
    discInput.value = cart.data.discountInput;
    tableNo.value = cart.data.tableNo;
    customer.value = cart.data.customerName;
  };

  // ---------- Save ----------
  let saving = false;
  const save = async (print: boolean) => {
    if (saving || cart.data.lines.length === 0) return;
    const discount = currentDiscount();
    if (!discountOk) {
      discInput.focus();
      return;
    }
    saving = true;
    saveBtn.disabled = printBtn.disabled = true;
    try {
      const d = cart.data;
      const bill = await saveBill({
        items: d.lines,
        orderType: d.orderType,
        tableNo: d.tableNo,
        customerName: d.customerName,
        paymentMode: d.paymentMode,
        discount,
      });
      cart.reset();
      syncInputs();
      panel.classList.remove('is-open');
      const { showReceipt } = await import('../receipt/receiptView');
      void showReceipt(bill, { autoPrint: print });
    } catch (err) {
      toast(err instanceof BillError ? err.message : 'Could not save the bill. Please try again.', 'error', 5000);
      renderBill();
    } finally {
      saving = false;
    }
  };
  saveBtn.addEventListener('click', () => void save(false));
  printBtn.addEventListener('click', () => void save(true));

  // ---------- Keyboard shortcuts ----------
  const onKey = (e: KeyboardEvent) => {
    if (document.querySelector('dialog[open]')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
      e.preventDefault(); // replace browser print with Save & Print
      if (cart.data.lines.length) void save(true);
      else toast('Add items before printing', 'info');
      return;
    }
    const t = e.target as HTMLElement;
    const typing = t.matches('input, textarea, select, [contenteditable]');
    if (e.key === '/' && !typing) {
      e.preventDefault();
      search.focus();
      search.select();
    }
  };
  document.addEventListener('keydown', onKey);

  const offMenu = onMenuChange((d) => {
    menu = d.filter((x) => x.active);
    byId = new Map(menu.map((x) => [x.id, x]));
    buildGrid();
    renderBill();
  });
  buildGrid();
  renderBill();

  return () => {
    document.removeEventListener('keydown', onKey);
    offCart();
    offMenu();
    onSearch.cancel();
    persist.cancel();
    void setMeta('cartDraft', cart.data);
  };
}
