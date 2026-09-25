import { h } from '../dom';

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

export interface Field<E extends HTMLElement> {
  wrap: HTMLDivElement;
  input: E;
  setError(msg: string | null): void;
}

/** Label + control + error message, wired with for/aria-describedby. */
export function field<E extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(label: string, input: E, hint?: string): Field<E> {
  const id = input.id || uid('f');
  input.id = id;
  const errId = `${id}-err`;
  const hintEl = hint ? h('p', { class: 'field-hint', text: hint, attrs: { id: `${id}-hint` } }) : null;
  const err = h('p', { class: 'field-error', attrs: { id: errId, hidden: true } });
  input.setAttribute('aria-describedby', [hintEl ? `${id}-hint` : '', errId].filter(Boolean).join(' '));
  const wrap = h('div', { class: 'field' }, h('label', { class: 'field-label', text: label, attrs: { for: id } }), input, hintEl, err);
  return {
    wrap,
    input,
    setError(msg) {
      err.textContent = msg ?? '';
      err.hidden = !msg;
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    },
  };
}

export function textInput(attrs: Record<string, string | number | boolean | undefined> = {}): HTMLInputElement {
  return h('input', { class: 'input', attrs: { type: 'text', autocomplete: 'off', ...attrs } });
}

export function select(options: [value: string, label: string][], value?: string, attrs: Record<string, string> = {}): HTMLSelectElement {
  const s = h('select', { class: 'input', attrs }, ...options.map(([v, l]) => h('option', { text: l, attrs: { value: v } })));
  if (value !== undefined) s.value = value;
  return s;
}

/** Segmented control made of radio buttons (keyboard + screen reader friendly). */
export function segmented(name: string, legend: string, options: [value: string, label: string][], value: string): {
  el: HTMLFieldSetElement;
  get(): string;
  set(v: string): void;
} {
  const inputs = options.map(([v, l]) => {
    const input = h('input', { class: 'seg-input', attrs: { type: 'radio', name, value: v, id: uid(name) } });
    input.checked = v === value;
    return { input, label: h('label', { class: 'seg-label', text: l, attrs: { for: input.id } }) };
  });
  const el = h(
    'fieldset',
    { class: 'segmented' },
    h('legend', { class: 'visually-hidden', text: legend }),
    ...inputs.flatMap((i) => [i.input, i.label]),
  );
  return {
    el,
    get: () => inputs.find((i) => i.input.checked)?.input.value ?? value,
    set: (v) => inputs.forEach((i) => (i.input.checked = i.input.value === v)),
  };
}

/** Accessible on/off switch (a button with role="switch"). */
export function toggle(label: string, on: boolean, attrs: Record<string, string> = {}): HTMLButtonElement {
  return h(
    'button',
    { class: 'switch', attrs: { type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': label, ...attrs } },
    h('span', { class: 'switch-thumb' }),
  );
}
