/**
 * "Bill date" on the billing screen (owner request, 24 Oct 2026): a bill forgotten
 * earlier this month can be entered with its own date. The phone's normal calendar
 * opens (input type=date), limited to the 1st of this month … today. Today means
 * a normal bill (saved with the current time).
 *
 * The chosen day stays until "Today" is tapped, so several forgotten bills of the
 * same day can be entered one after another; a clear note shows while it is on.
 */
import { h } from '../dom';
import { formatDateISO } from '../../core/dates';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** "2026-10-20" + "14:30" → that local time in ms, or null if not a real date/time. */
export function localTime(date: string, time: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const at = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  return formatDateISO(at.getTime()) === date && at.getHours() === Number(t[1]) ? at.getTime() : null;
}

/** The days a bill may be entered for: the 1st of this month … today (YYYY-MM-DD). */
export function allowedRange(now: number): { min: string; max: string } {
  const max = formatDateISO(now);
  return { min: `${max.slice(0, 8)}01`, max };
}

export interface BillDateField {
  el: HTMLElement;
  /**
   * The chosen earlier time; undefined for a normal bill now; null when it can't be used
   * (no valid time, or the month has moved on since it was chosen: then it is reset to today).
   */
  billedAt(now?: number): number | undefined | null;
  /** Why billedAt() gave null, to show the cashier. */
  problem: string;
  reset(): void;
}

export function billDateField(onChange: () => void = () => undefined): BillDateField {
  const date = h('input', { class: 'input bill-date', attrs: { type: 'date', 'aria-label': 'Bill date', required: true } }) as HTMLInputElement;
  const time = h('input', { class: 'input bill-time', attrs: { type: 'time', 'aria-label': 'Bill time', hidden: true } }) as HTMLInputElement;
  const today = h('button', { class: 'btn btn-ghost btn-sm', text: 'Today', attrs: { type: 'button', hidden: true } });
  const note = h('p', { class: 'bill-date-note', attrs: { hidden: true, role: 'status' } });
  const el = h(
    'div',
    { class: 'bill-date-field' },
    h('div', { class: 'date-row' }, h('span', { class: 'field-label', text: 'Bill date' }), date, time, today),
    note,
  );

  const limits = (now = Date.now()) => {
    const r = allowedRange(now);
    date.min = r.min;
    date.max = r.max;
    return r;
  };

  // Only a date the cashier picked is "earlier". Otherwise the field just shows today, and a
  // screen left open past midnight still saves new bills with the real time (never yesterday).
  let chosen = false;

  const show = () => {
    time.hidden = !chosen;
    today.hidden = !chosen;
    note.hidden = !chosen;
    el.classList.toggle('is-past', chosen);
    if (chosen) {
      const at = localTime(date.value, time.value || '12:00');
      const d = at === null ? null : new Date(at);
      note.textContent = d
        ? `Adding a bill for an earlier date: ${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}. Tap Today when you're done.`
        : 'Choose a date and time.';
    }
  };

  const reset = () => {
    chosen = false;
    date.value = limits().max;
    show();
    onChange();
  };

  date.addEventListener('change', () => {
    const { min, max } = limits();
    if (!date.value || date.value < min || date.value > max) date.value = max; // only this month, never the future
    chosen = date.value !== max;
    if (chosen && !time.value) {
      const now = new Date();
      time.value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }
    show();
    onChange();
  });
  time.addEventListener('change', () => {
    show();
    onChange();
  });
  today.addEventListener('click', reset);
  reset();

  const field: BillDateField = {
    el,
    reset,
    problem: '',
    billedAt(now = Date.now()) {
      const { min, max } = limits(now);
      if (!chosen || date.value === max) {
        if (date.value !== max) date.value = max; // a new day began while the screen was open
        if (chosen) reset();
        return undefined;
      }
      if (date.value < min || date.value > max) {
        reset(); // a new month began since it was chosen: never save it under the wrong month
        field.problem = 'The bill date was set back to today: earlier bills can only be added for this month. Check it and save again.';
        return null;
      }
      const at = localTime(date.value, time.value);
      if (at === null || at > now) {
        field.problem = 'Choose a valid time for the bill date.';
        time.focus();
        return null;
      }
      return at;
    },
  };
  return field;
}
