/**
 * Tiny DOM builder. Text is only ever set through text nodes / textContent,
 * so user input can never be interpreted as HTML (XSS-safe by construction).
 */

type Child = Node | string | number | false | null | undefined;

export interface Props {
  class?: string;
  text?: string;
  dataset?: Record<string, string>;
  /** Plain attributes (aria-*, type, role, name, value, …). `style` is not allowed (CSP). */
  attrs?: Record<string, string | number | boolean | undefined>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void }>;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.dataset) Object.assign(el.dataset, props.dataset);
  if (props.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) {
      if (v === undefined || v === false) continue;
      if (k === 'style' || k.startsWith('on')) throw new Error(`h(): attribute "${k}" not allowed`);
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (props.on) {
    for (const [type, fn] of Object.entries(props.on)) {
      el.addEventListener(type, fn as EventListener);
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

/** Replace all children of `el`. */
export function replaceChildren(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** Inline SVG element builder (for icons and charts). */
export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  ...children: (SVGElement | string)[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style' || k.startsWith('on')) throw new Error(`svg(): attribute "${k}" not allowed`);
    el.setAttribute(k, String(v));
  }
  for (const c of children) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

/** Schedule a DOM write on the next animation frame; repeated calls in one frame collapse. */
export function rafBatch(fn: () => void): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn();
    });
  };
}

export function $(sel: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}
