import type { TagSummary } from "@docmind/contracts";

/** A tag as the server lists it; the id is a valid uuid made from `n`. */
export const tag = (n: number, name: string, documents: number): TagSummary => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  name,
  documents,
});
/** The shadow root of a mounted element. */
export const root = (el: Element) => el.shadowRoot as ShadowRoot;
/** The first match inside an element's shadow root. */
export const q = <T extends Element>(el: Element, selector: string) =>
  root(el).querySelector(selector) as T;
/** Every match inside an element's shadow root. */
export const all = <T extends Element>(el: Element, selector: string) =>
  [...root(el).querySelectorAll(selector)] as T[];
