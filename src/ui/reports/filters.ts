import { h } from '../dom';
import { select, textInput } from '../components/form';
import { presetRange, customRange, monthKeyRange, formatMonthKey, formatDateISO, formatDateTime, type Preset, type Range } from '../../core/dates';
import { monthKeyOf } from '../../core/billNo';
import { parseRupees } from '../../core/money';
import { debounce } from '../../core/debounce';
import type { ReportFilter } from './query';
import type { OrderType, PaymentMode } from '../../db/types';

type PresetChoice = Preset | 'pick' | 'custom';

const PRESET_LABEL: Record<PresetChoice, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This week',
  month: 'This month',
  lastMonth: 'Last month',
  pick: 'Pick a month',
  custom: 'Custom range',
};

export interface FilterBar {
  el: HTMLElement;
  current(): { filter: ReportFilter; label: string };
}

export function filterBar(categories: string[], onChange: () => void): FilterBar {
  const now = Date.now();
  const preset = select(Object.entries(PRESET_LABEL) as [string, string][], 'month', { 'aria-label': 'Date range' });
  const month = h('input', { class: 'input', attrs: { type: 'month', 'aria-label': 'Month', max: `${monthKeyOf(now).slice(0, 4)}-${monthKeyOf(now).slice(4)}` } });
  month.value = `${monthKeyOf(now).slice(0, 4)}-${monthKeyOf(now).slice(4)}`;
  const from = h('input', { class: 'input', attrs: { type: 'date', 'aria-label': 'From date' } });
  const to = h('input', { class: 'input', attrs: { type: 'date', 'aria-label': 'To date' } });
  from.value = formatDateISO(presetRange('month', now).start);
  to.value = formatDateISO(now);
  const monthWrap = h('div', { class: 'filter-extra', attrs: { hidden: true } }, month);
  const customWrap = h('div', { class: 'filter-extra range-inputs', attrs: { hidden: true } }, from, h('span', { class: 'muted', text: 'to' }), to);

  const category = select([['', 'All categories'], ...categories.map((c): [string, string] => [c, c])], '', { 'aria-label': 'Category' });
  const payment = select([['', 'All payments'], ['cash', 'Cash'], ['upi', 'UPI']], '', { 'aria-label': 'Payment mode' });
  const orderType = select([['', 'All order types'], ['dine-in', 'Dine-in'], ['takeaway', 'Takeaway'], ['delivery', 'Delivery']], '', { 'aria-label': 'Order type' });
  const food = select([['', 'Veg & non-veg'], ['veg', 'Veg only'], ['nonveg', 'Non-veg only']], '', { 'aria-label': 'Food type' });
  const min = textInput({ inputmode: 'decimal', placeholder: 'Min ₹', 'aria-label': 'Minimum bill amount' });
  const max = textInput({ inputmode: 'decimal', placeholder: 'Max ₹', 'aria-label': 'Maximum bill amount' });
  const billNo = textInput({ placeholder: 'Bill no. e.g. 0042', 'aria-label': 'Search by bill number', maxlength: 20 });
  const showVoid = h('input', { attrs: { type: 'checkbox', id: 'f-void' } });
  const reset = h('button', { class: 'btn btn-ghost btn-sm', text: 'Clear filters', attrs: { type: 'button' } });
  const summary = h('summary', { class: 'more-summary', text: 'More filters' });

  const more = h(
    'details',
    { class: 'more-filters' },
    summary,
    h(
      'div',
      { class: 'more-grid' },
      category,
      payment,
      orderType,
      food,
      h('div', { class: 'range-inputs' }, min, h('span', { class: 'muted', text: '–' }), max),
      billNo,
      h('label', { class: 'check-row', attrs: { for: 'f-void' } }, showVoid, h('span', { text: 'Include voided bills in list' })),
      reset,
    ),
  );

  const el = h('div', { class: 'filters' }, h('div', { class: 'filter-row' }, preset, monthWrap, customWrap), more);

  const money = (input: HTMLInputElement): number | undefined => {
    const raw = input.value.trim();
    if (!raw) {
      input.removeAttribute('aria-invalid');
      return undefined;
    }
    const p = parseRupees(raw);
    if (p === null) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    return p ?? undefined;
  };

  const current = (): { filter: ReportFilter; label: string } => {
    const p = preset.value as PresetChoice;
    let range: Range;
    let label: string;
    if (p === 'pick') {
      const key = /^\d{4}-\d{2}$/.test(month.value) ? month.value.replace('-', '') : monthKeyOf(now);
      range = monthKeyRange(key);
      label = formatMonthKey(key);
    } else if (p === 'custom') {
      range = customRange(from.value, to.value) ?? presetRange('today', now);
      label = `${formatDateTime(range.start).slice(0, 10)} – ${formatDateTime(range.end - 1).slice(0, 10)}`;
    } else {
      range = presetRange(p, Date.now());
      label = p === 'month' || p === 'lastMonth' ? `${PRESET_LABEL[p]} · ${formatMonthKey(monthKeyOf(range.start))}` : PRESET_LABEL[p];
    }
    const filter: ReportFilter = {
      range,
      category: category.value || undefined,
      payment: (payment.value || undefined) as PaymentMode | undefined,
      orderType: (orderType.value || undefined) as OrderType | undefined,
      food: (food.value || undefined) as 'veg' | 'nonveg' | undefined,
      minPaise: money(min),
      maxPaise: money(max),
      billNo: billNo.value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, '') || undefined,
      showVoid: showVoid.checked,
    };
    const active = [filter.category, filter.payment, filter.orderType, filter.food, filter.minPaise, filter.maxPaise, filter.billNo, filter.showVoid || undefined].filter((x) => x !== undefined).length;
    summary.textContent = active ? `More filters (${active} on)` : 'More filters';
    return { filter, label };
  };

  preset.addEventListener('change', () => {
    monthWrap.hidden = preset.value !== 'pick';
    customWrap.hidden = preset.value !== 'custom';
    onChange();
  });
  const later = debounce(onChange, 300);
  for (const c of [month, from, to, category, payment, orderType, food, showVoid]) c.addEventListener('change', onChange);
  for (const c of [min, max, billNo]) c.addEventListener('input', later);
  reset.addEventListener('click', () => {
    for (const s of [category, payment, orderType, food]) s.value = '';
    for (const i of [min, max, billNo]) i.value = '';
    showVoid.checked = false;
    onChange();
  });

  return { el, current };
}
