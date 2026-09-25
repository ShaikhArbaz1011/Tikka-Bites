import '../../styles/reports.css';
import { h, replaceChildren } from '../dom';
import { icon } from '../components/icons';
import { toast } from '../components/toast';
import { filterBar } from './filters';
import { runReport, dishRankings, monthComparison, pctChange, type ReportFilter, type DishRank } from './query';
import { columnChart, rowChart, shareBar, lineChart, responsive, withTooltip } from './charts';
import { billList } from './billList';
import { exportBillsCsv, exportItemsCsv } from './exportCsv';
import { getMenu } from '../../state/menuStore';
import { listMenu } from '../../db/menuRepo';
import { getSettings } from '../../db/settingsRepo';
import { formatINR, formatCompactINR } from '../../core/money';
import { formatMonthKey, WEEKDAYS } from '../../core/dates';
import { monthKeyOf } from '../../core/billNo';
import type { Stats } from '../../db/types';
import type { Cleanup } from '../../router';

type Cell = string | number | Node;

function dataTable(caption: string, head: string[], rows: Cell[][]): HTMLElement {
  return h('details', { class: 'data-table' },
    h('summary', { text: 'Show data table' }),
    h('div', { class: 'table-scroll' },
      h('table', {},
        h('caption', { class: 'visually-hidden', text: caption }),
        h('thead', {}, h('tr', {}, ...head.map((x) => h('th', { text: x, attrs: { scope: 'col' } })))),
        h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, typeof c === 'object' ? c : String(c)))))))));
}

function card(title: string, sub: string | null, ...body: Node[]): HTMLElement {
  return h('section', { class: 'card report-card' },
    h('h2', { class: 'card-title', text: title }),
    sub ? h('p', { class: 'muted card-sub', text: sub }) : null,
    ...body);
}

export async function mount(root: HTMLElement): Promise<Cleanup> {
  const [settings, menuAll] = await Promise.all([getSettings(), listMenu(true), getMenu()]);
  const sym = settings.currencySymbol;
  const money = (p: number) => formatINR(p, sym);
  const compact = (p: number) => formatCompactINR(p, sym);
  const wholeRupees = (p: number) => money(Math.round(p / 100) * 100).replace(/\.00$/, '');
  const categories = [...new Set(menuAll.map((d) => d.category))]; // menu-card order

  const cleanups: (() => void)[] = [];
  const title = h('p', { class: 'muted range-label' });
  const statusLine = h('p', { class: 'muted status-line', attrs: { role: 'status' } });
  const csvBills = h('button', { class: 'btn btn-sm', attrs: { type: 'button' } }, icon('download', 16), 'Bills CSV');
  const csvItems = h('button', { class: 'btn btn-sm', attrs: { type: 'button' } }, icon('download', 16), 'Items CSV');
  const body = h('div', { class: 'report-body' });
  const bills = billList(() => refresh());
  cleanups.push(() => bills.destroy());
  const filters = filterBar(categories, () => refresh());

  root.append(
    h('header', { class: 'page-head' },
      h('div', {}, h('h1', { class: 'page-title', text: 'Reports' }), title),
      h('div', { class: 'btn-row' }, csvBills, csvItems)),
    filters.el,
    statusLine,
    body,
    card('Bills', 'Newest first. View to reprint (same cheesy line), or void with a reason.', bills.el),
  );

  const exportWith = (fn: (f: ReportFilter) => Promise<number>) => async () => {
    const n = await fn(filters.current().filter);
    toast(n ? `Exported ${n.toLocaleString('en-IN')} rows` : 'Nothing to export for these filters', n ? 'success' : 'info');
  };
  csvBills.addEventListener('click', exportWith(exportBillsCsv));
  csvItems.addEventListener('click', exportWith(exportItemsCsv));

  const chartHost = (draw: (w: number) => SVGSVGElement) => {
    const host = h('div', { class: 'chart-host' });
    withTooltip(host);
    // Draw after insertion so the width is known.
    requestAnimationFrame(() => cleanups.push(responsive(host, draw)));
    return host;
  };

  const kpis = (s: Stats, voided: number) => {
    const avg = s.billCount ? Math.round(s.revenuePaise / s.billCount) : 0;
    const tile = (label: string, value: string, note?: string) =>
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-label', text: label }), h('span', { class: 'kpi-value', text: value }), note ? h('span', { class: 'kpi-note muted', text: note }) : null);
    return h('div', { class: 'kpis' },
      tile('Revenue', money(s.revenuePaise)),
      tile('Bills', s.billCount.toLocaleString('en-IN'), voided ? `${voided} voided (excluded)` : undefined),
      tile('Average bill', money(avg)),
      tile('Items sold', s.itemsSold.toLocaleString('en-IN')),
      tile('Discounts given', money(s.discountPaise)));
  };

  const rankTable = (rows: DishRank[], mode: 'qty' | 'paise' | 'least') => {
    if (!rows.length) return h('p', { class: 'muted empty-note', text: 'No dishes to show.' });
    const max = Math.max(...rows.map((r) => (mode === 'paise' ? r.paise : r.qty)), 1);
    return h('ol', { class: 'rank-list' }, ...rows.map((r, i) => {
      const v = mode === 'paise' ? r.paise : r.qty;
      const bar = h('span', { class: 'rank-bar' });
      bar.style.width = `${Math.max(v > 0 ? 2 : 0, (v / max) * 100)}%`;
      return h('li', { class: 'rank-row' },
        h('span', { class: 'rank-no', text: String(i + 1) }),
        h('span', { class: 'rank-name', text: r.name }),
        h('span', { class: 'rank-val', text: mode === 'paise' ? money(r.paise) : `${r.qty.toLocaleString('en-IN')} sold` }),
        h('span', { class: 'rank-track' }, bar));
    }));
  };

  const render = async (f: ReportFilter, label: string, my: number) => {
    const data = await runReport(f);
    const s = data.stats;
    const ranks = dishRankings(s, menuAll, f);
    const cmp = await monthComparison(monthKeyOf(f.range.start));
    if (my !== token) return; // a newer filter change won
    statusLine.textContent = data.source === 'summary'
      ? `Instant summary · ${s.billCount.toLocaleString('en-IN')} bills`
      : `Scanned ${data.scanned.toLocaleString('en-IN')} bills in ${Math.round(data.ms)} ms`;
    title.textContent = label;

    if (s.billCount === 0 && data.voided === 0) {
      replaceChildren(body, h('div', { class: 'empty' },
        h('p', { class: 'empty-title', text: 'No sales in this period' }),
        h('p', { class: 'muted', text: 'Pick another date range, or create a bill from the Billing screen.' })));
      return;
    }

    // Category sales
    const cats = Object.entries(s.byCategory).filter(([, v]) => v.qty > 0).sort((a, b) => b[1].paise - a[1].paise);
    const catRows = cats.map(([name, v]) => ({ label: name, value: v.paise, display: compact(v.paise), tip: `${name}\n${money(v.paise)} · ${v.qty} sold` }));

    // Payment split (fixed order → color follows the payment mode, never its rank)
    const pay = (['cash', 'upi', 'card'] as const).map((k, i) => ({ k, label: ['Cash', 'UPI', 'Card'][i]!, cls: (['s1', 's2', 's3'] as const)[i]!, v: s.byPayment[k] ?? { count: 0, paise: 0 } }));
    const payTotal = pay.reduce((t, p) => t + p.v.paise, 0) || 1;
    const pct = (p: number) => `${Math.round((p / payTotal) * 100)}%`;

    // Peak hours (bills per hour) and weekdays (revenue, Mon-first)
    const hours = s.byHour.map((x) => x.count);
    const hourLabel = (i: number) => (i === 0 ? '12a' : i < 12 ? `${i}a` : i === 12 ? '12p' : `${i - 12}p`);
    const wdOrder = [1, 2, 3, 4, 5, 6, 0];

    // Month over month (cumulative revenue by day)
    const daysIn = (key: string) => new Date(Number(key.slice(0, 4)), Number(key.slice(4)), 0).getDate();
    const nDays = Math.max(daysIn(cmp.curKey), daysIn(cmp.prevKey));
    const today = new Date();
    const curIsThisMonth = cmp.curKey === monthKeyOf(today);
    const cumulative = (st: Stats, days: number, stopAt?: number) => {
      let acc = 0;
      return Array.from({ length: nDays }, (_, i) => {
        if (i >= days || (stopAt !== undefined && i + 1 > stopAt)) return null;
        acc += st.byDay[String(i + 1)] ?? 0;
        return acc;
      });
    };
    const curLine = cumulative(cmp.cur, daysIn(cmp.curKey), curIsThisMonth ? today.getDate() : undefined);
    const prevLine = cumulative(cmp.prev, daysIn(cmp.prevKey));
    const curName = formatMonthKey(cmp.curKey);
    const prevName = formatMonthKey(cmp.prevKey);
    const avg = (x: Stats) => (x.billCount ? Math.round(x.revenuePaise / x.billCount) : 0);
    const momRow = (label2: string, a: number, b: number, fmt: (n: number) => string) => {
      const c = pctChange(a, b);
      const change = c === null
        ? h('span', { class: 'muted', text: '—' })
        : h('span', { class: `delta ${c >= 0 ? 'up' : 'down'}`, text: `${c >= 0 ? '▲' : '▼'} ${Math.abs(c).toFixed(1)}%` });
      return h('tr', {}, h('th', { text: label2, attrs: { scope: 'row' } }), h('td', { text: fmt(a) }), h('td', { text: fmt(b) }), h('td', {}, change));
    };
    const num = (n: number) => n.toLocaleString('en-IN');

    replaceChildren(body,
      kpis(s, data.voided),
      h('div', { class: 'report-grid' },
        card('Most sold · by quantity', 'Top 10 dishes', rankTable(ranks.byQty, 'qty')),
        card('Most sold · by revenue', 'Top 10 dishes', rankTable(ranks.byRevenue, 'paise')),
        card('Least sold', 'Dishes on your menu selling least — candidates to rethink', rankTable(ranks.least, 'least')),
        card('Sales by category', null,
          catRows.length ? chartHost((w) => rowChart(w, 'Sales by category', catRows)) : h('p', { class: 'muted empty-note', text: 'No sales.' }),
          dataTable('Sales by category', ['Category', 'Qty', 'Revenue'], cats.map(([n, v]) => [n, num(v.qty), money(v.paise)]))),
        card('Payment split', null,
          chartHost((w) => shareBar(w, `Payment split: ${pay.map((p) => `${p.label} ${pct(p.v.paise)}`).join(', ')}`,
            pay.map((p) => ({ label: p.label, value: p.v.paise, cls: p.cls, tip: `${p.label}\n${money(p.v.paise)} · ${p.v.count} bills · ${pct(p.v.paise)}` })))),
          h('ul', { class: 'legend' }, ...pay.map((p) => h('li', {},
            h('span', { class: `swatch ${p.cls}` }),
            h('span', { class: 'legend-label', text: p.label }),
            h('span', { class: 'legend-val', text: `${money(p.v.paise)} · ${pct(p.v.paise)}` }))))),
        card('Peak hours', 'Bills per hour of day',
          chartHost((w) => columnChart(w, { label: 'Bills per hour of day', values: hours, xLabels: hours.map((_, i) => hourLabel(i)), labelEvery: w < 480 ? 6 : 3, format: (n) => num(n), tip: (i) => `${hourLabel(i)}–${hourLabel((i + 1) % 24)}\n${s.byHour[i]!.count} bills · ${money(s.byHour[i]!.paise)}` })),
          dataTable('Bills per hour', ['Hour', 'Bills', 'Revenue'], s.byHour.map((x, i) => [hourLabel(i), x.count, money(x.paise)]))),
        card('Best days of the week', 'Revenue by weekday',
          chartHost((w) => columnChart(w, { label: 'Revenue by weekday', values: wdOrder.map((d) => s.byWeekday[d]!.paise), xLabels: wdOrder.map((d) => WEEKDAYS[d]!), format: compact, tip: (i) => `${WEEKDAYS[wdOrder[i]!]}\n${money(s.byWeekday[wdOrder[i]!]!.paise)} · ${s.byWeekday[wdOrder[i]!]!.count} bills` })),
          dataTable('Revenue by weekday', ['Day', 'Bills', 'Revenue'], wdOrder.map((d) => [WEEKDAYS[d]!, s.byWeekday[d]!.count, money(s.byWeekday[d]!.paise)]))),
      ),
      card(`Month over month · ${curName} vs ${prevName}`, 'Whole-month totals (voided bills excluded)',
        h('div', { class: 'table-scroll' }, h('table', { class: 'mom-table' },
          h('thead', {}, h('tr', {}, h('th', { text: 'Metric', attrs: { scope: 'col' } }), h('th', { text: curName, attrs: { scope: 'col' } }), h('th', { text: prevName, attrs: { scope: 'col' } }), h('th', { text: 'Change', attrs: { scope: 'col' } }))),
          h('tbody', {},
            momRow('Revenue', cmp.cur.revenuePaise, cmp.prev.revenuePaise, wholeRupees),
            momRow('Bills', cmp.cur.billCount, cmp.prev.billCount, num),
            momRow('Average bill', avg(cmp.cur), avg(cmp.prev), wholeRupees),
            momRow('Items sold', cmp.cur.itemsSold, cmp.prev.itemsSold, num),
            momRow('Discounts', cmp.cur.discountPaise, cmp.prev.discountPaise, wholeRupees)))),
        h('h3', { class: 'sub-title', text: 'Revenue so far, day by day' }),
        h('ul', { class: 'legend' },
          h('li', {}, h('span', { class: 'swatch line-swatch s1' }), h('span', { class: 'legend-label', text: curName })),
          h('li', {}, h('span', { class: 'swatch line-swatch s2' }), h('span', { class: 'legend-label', text: prevName }))),
        chartHost((w) => lineChart(w, `Cumulative revenue: ${curName} vs ${prevName}`,
          [{ name: curName, cls: 's1', values: curLine }, { name: prevName, cls: 's2', values: prevLine }],
          Array.from({ length: nDays }, (_, i) => String(i + 1)), compact,
          (i) => `Day ${i + 1}\n${curName}: ${curLine[i] === null ? '—' : money(curLine[i]!)}\n${prevName}: ${prevLine[i] === null ? '—' : money(prevLine[i]!)}`)),
        dataTable('Cumulative revenue by day', ['Day', curName, prevName], Array.from({ length: nDays }, (_, i) => [i + 1, curLine[i] === null ? '—' : money(curLine[i]!), prevLine[i] === null ? '—' : money(prevLine[i]!)]))),
    );
  };

  let token = 0;
  const refresh = () => {
    const my = ++token;
    const { filter, label } = filters.current();
    for (const c of cleanups.splice(1)) c(); // keep bill list observer; drop old chart observers
    const slow = setTimeout(() => {
      if (my === token) statusLine.textContent = 'Crunching numbers…';
    }, 200);
    bills.load(filter, sym);
    void render(filter, label, my)
      .catch((e) => {
        console.error(e);
        toast('Could not load the report', 'error');
      })
      .finally(() => clearTimeout(slow));
  };

  refresh();
  return () => cleanups.forEach((c) => c());
}
