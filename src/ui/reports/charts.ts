/**
 * Hand-written SVG charts (no chart library). Each chart is drawn at the
 * container's real pixel width so text never scales, and redrawn on resize.
 * Marks carry `data-tip` text; one delegated tooltip layer per chart shows it.
 * Colors come from CSS classes (.s1/.s2/.s3) so light/dark themes switch in CSS.
 */
import { h, svg } from '../dom';

type El = SVGElement;

// ---------- layout helpers ----------

/** A "nice" axis maximum and step (1/2/5 × 10^n) for ~4 gridlines. */
export function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (max <= 0) return { max: ticks, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  return { max: step * Math.ceil(max / step), step };
}

/** Bar path with 4px rounded ends at the data end, square at the baseline. */
function colPath(x: number, y: number, w: number, hgt: number): string {
  const r = Math.min(4, w / 2, hgt);
  return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
}
function rowPath(x: number, y: number, w: number, hgt: number): string {
  const r = Math.min(4, hgt / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt - r}Q${x + w},${y + hgt} ${x + w - r},${y + hgt}H${x}Z`;
}

function truncate(s: string, maxChars: number): string {
  return s.length <= maxChars ? s : `${s.slice(0, Math.max(1, maxChars - 1))}…`;
}

function root(w: number, hgt: number, label: string, ...children: El[]): SVGSVGElement {
  return svg('svg', { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, role: 'img', 'aria-label': label, class: 'chart-svg' }, ...children);
}

// ---------- tooltip + responsiveness ----------

/** Delegated hover tooltip for any descendant with data-tip. */
export function withTooltip(container: HTMLElement): void {
  const tip = h('div', { class: 'chart-tip', attrs: { hidden: true, 'aria-hidden': 'true' } });
  container.append(tip);
  let active: Element | null = null;
  container.addEventListener('pointermove', (e) => {
    const target = (e.target as Element).closest('[data-tip]');
    if (!target) {
      tip.hidden = true;
      active?.classList.remove('is-hover');
      active = null;
      return;
    }
    if (target !== active) {
      active?.classList.remove('is-hover');
      active = target;
      active.classList.add('is-hover');
      tip.textContent = target.getAttribute('data-tip');
    }
    const box = container.getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    tip.hidden = false;
    const flip = x > box.width - tip.offsetWidth - 16;
    tip.style.left = `${flip ? x - tip.offsetWidth - 12 : x + 12}px`;
    tip.style.top = `${Math.max(0, y - tip.offsetHeight - 8)}px`;
  });
  container.addEventListener('pointerleave', () => {
    tip.hidden = true;
    active?.classList.remove('is-hover');
    active = null;
  });
}

/** Draw into `host` at its current width; redraw when the width changes. */
export function responsive(host: HTMLElement, draw: (width: number) => SVGSVGElement): () => void {
  let lastW = 0;
  const paint = () => {
    const w = Math.floor(host.clientWidth);
    if (!w || w === lastW) return;
    lastW = w;
    host.querySelector('svg')?.remove();
    host.prepend(draw(w));
  };
  const ro = new ResizeObserver(() => requestAnimationFrame(paint));
  ro.observe(host);
  paint();
  return () => ro.disconnect();
}

// ---------- charts ----------

export interface ColumnOpts {
  label: string;
  values: number[];
  xLabels: string[];
  labelEvery?: number;
  format: (n: number) => string;
  tip: (i: number) => string;
  height?: number;
}

/** Vertical columns (single series). Direct label on the peak only. */
export function columnChart(w: number, o: ColumnOpts): SVGSVGElement {
  const H = o.height ?? 220;
  const padL = 48;
  const padB = 24;
  const padT = 20;
  const plotW = w - padL - 4;
  const plotH = H - padB - padT;
  const n = o.values.length;
  const { max, step } = niceScale(Math.max(...o.values, 0));
  const slot = plotW / n;
  const gap = Math.min(2 + slot * 0.2, 12);
  const bw = Math.max(2, slot - gap);
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const els: El[] = [];

  for (let t = 0; t <= max + 1e-9; t += step) {
    els.push(svg('line', { x1: padL, x2: w - 4, y1: y(t), y2: y(t), class: t === 0 ? 'axis-base' : 'grid' }));
    els.push(svg('text', { x: padL - 6, y: y(t) + 4, class: 'tick', 'text-anchor': 'end' }, o.format(t)));
  }
  const peak = o.values.indexOf(Math.max(...o.values));
  o.values.forEach((v, i) => {
    const x = padL + i * slot + gap / 2;
    const bh = (v / max) * plotH;
    const g = svg('g', { class: 'mark', 'data-tip': o.tip(i) }, svg('rect', { x: padL + i * slot, y: padT, width: slot, height: plotH, class: 'hit' }));
    if (bh > 0) g.append(svg('path', { d: colPath(x, y(v), bw, bh), class: 'bar s1' }));
    els.push(g);
    if ((o.labelEvery ?? 1) === 1 || i % (o.labelEvery ?? 1) === 0) {
      els.push(svg('text', { x: x + bw / 2, y: H - 6, class: 'tick', 'text-anchor': 'middle' }, o.xLabels[i] ?? ''));
    }
  });
  if (o.values[peak]! > 0) {
    const x = padL + peak * slot + gap / 2 + bw / 2;
    els.push(svg('text', { x, y: y(o.values[peak]!) - 6, class: 'value-label', 'text-anchor': 'middle' }, o.format(o.values[peak]!)));
  }
  return root(w, H, o.label, ...els);
}

export interface RowDatum {
  label: string;
  value: number;
  display: string;
  tip: string;
}

/** Horizontal bars (single series), sorted by caller; value labels at bar ends. */
export function rowChart(w: number, label: string, rows: RowDatum[]): SVGSVGElement {
  const rowH = 30;
  const barH = 18;
  const labelW = Math.min(150, Math.max(80, w * 0.32));
  const valueW = 76;
  const plotW = Math.max(20, w - labelW - valueW - 8);
  const max = Math.max(...rows.map((r) => r.value), 1);
  const H = rows.length * rowH + 4;
  const els: El[] = [];
  rows.forEach((r, i) => {
    const top = i * rowH + 2;
    const bw = Math.max(r.value > 0 ? 2 : 0, (r.value / max) * plotW);
    const g = svg(
      'g',
      { class: 'mark', 'data-tip': r.tip },
      svg('rect', { x: 0, y: top, width: w, height: rowH, class: 'hit' }),
      svg('text', { x: 0, y: top + rowH / 2 + 4, class: 'row-label' }, truncate(r.label, Math.floor(labelW / 7.2))),
    );
    if (bw > 0) g.append(svg('path', { d: rowPath(labelW, top + (rowH - barH) / 2, bw, barH), class: 'bar s1' }));
    g.append(svg('text', { x: labelW + bw + 6, y: top + rowH / 2 + 4, class: 'value-label' }, r.display));
    els.push(g);
  });
  return root(w, H, label, ...els);
}

export interface SharePart {
  label: string;
  value: number;
  cls: 's1' | 's2' | 's3';
  tip: string;
}

/** Part-to-whole as one stacked horizontal bar with 2px surface gaps. */
export function shareBar(w: number, label: string, parts: SharePart[]): SVGSVGElement {
  const H = 28;
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const els: El[] = [svg('rect', { x: 0, y: 0, width: w, height: H, rx: 4, class: 'track' })];
  let x = 0;
  const visible = parts.filter((p) => p.value > 0);
  visible.forEach((p, i) => {
    const segW = (p.value / total) * w - (i < visible.length - 1 ? 2 : 0);
    els.push(svg('g', { class: 'mark', 'data-tip': p.tip }, svg('rect', { x, y: 0, width: Math.max(1, segW), height: H, rx: 4, class: `bar ${p.cls}` })));
    x += segW + 2;
  });
  return root(w, H, label, ...els);
}

export interface LineSeries {
  name: string;
  cls: 's1' | 's2';
  values: (number | null)[];
}

/** Multi-series line (≤ 2 here) with crosshair columns carrying the tooltip. */
export function lineChart(w: number, label: string, series: LineSeries[], xLabels: string[], format: (n: number) => string, tip: (i: number) => string): SVGSVGElement {
  const H = 240;
  const padL = 52;
  const padR = 12;
  const padT = 16;
  const padB = 24;
  const n = xLabels.length;
  const plotW = w - padL - padR;
  const plotH = H - padT - padB;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const { max, step } = niceScale(Math.max(...all, 0));
  const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const els: El[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) {
    els.push(svg('line', { x1: padL, x2: w - padR, y1: y(t), y2: y(t), class: t === 0 ? 'axis-base' : 'grid' }));
    els.push(svg('text', { x: padL - 6, y: y(t) + 4, class: 'tick', 'text-anchor': 'end' }, format(t)));
  }
  const every = Math.ceil(n / Math.max(2, Math.floor(plotW / 40)));
  xLabels.forEach((l, i) => {
    if (i % every === 0 || i === n - 1) els.push(svg('text', { x: x(i), y: H - 6, class: 'tick', 'text-anchor': 'middle' }, l));
  });
  // Draw the comparison series first so "this month" sits on top.
  for (const s of [...series].reverse()) {
    let d = '';
    s.values.forEach((v, i) => {
      if (v === null) return;
      d += `${d ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    });
    if (d) els.push(svg('path', { d, class: `line ${s.cls}` }));
  }
  // Crosshair hit columns.
  const colW = n > 1 ? plotW / (n - 1) : plotW;
  for (let i = 0; i < n; i++) {
    const g = svg('g', { class: 'mark xhair', 'data-tip': tip(i) }, svg('rect', { x: x(i) - colW / 2, y: padT, width: colW, height: plotH, class: 'hit' }), svg('line', { x1: x(i), x2: x(i), y1: padT, y2: padT + plotH, class: 'xhair-line' }));
    for (const s of series) {
      const v = s.values[i];
      if (v !== null && v !== undefined) g.append(svg('circle', { cx: x(i), cy: y(v), r: 4, class: `dot ${s.cls}` }));
    }
    els.push(g);
  }
  return root(w, H, label, ...els);
}
