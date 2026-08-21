/*
 * The one DOM helper everything is built with. `attrs` is deliberately loose -
 * `class` and `text` are shorthands, anything starting with `on` is wired up as
 * a listener, and the rest goes through setAttribute. `null` and `false` values
 * are dropped rather than rendered, so a conditional attribute or child can be
 * written inline without a surrounding `if`.
 */
export type ElChild = Node | string | null | false | undefined;

export interface ElAttrs {
  [name: string]: string | number | boolean | EventListener | null | undefined;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: ElAttrs | null,
  ...children: (ElChild | ElChild[])[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value == null || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key === 'text') node.textContent = String(value);
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value as EventListener);
      else node.setAttribute(key, String(value));
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}
