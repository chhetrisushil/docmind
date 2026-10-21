const CONTROLS =
  "button:not([hidden]), a[href]:not([hidden]), input:not([type=hidden]):not([hidden]), select:not([hidden]), textarea:not([hidden]), [role=tab]:not([hidden])";

export function deepAll(root: ParentNode, selector: string): Element[] {
  const out: Element[] = [...root.querySelectorAll(selector)];
  for (const host of root.querySelectorAll("*"))
    if (host.shadowRoot) out.push(...deepAll(host.shadowRoot, selector));
  if ((root as Element).shadowRoot)
    out.push(...deepAll((root as Element).shadowRoot as ShadowRoot, selector));
  return out;
}
export const deepFind = (root: ParentNode, selector: string): Element | null =>
  deepAll(root, selector)[0] ?? null;

export function deepText(root: ParentNode): string {
  let text = (root as Element).textContent ?? "";
  const hosts = [...root.querySelectorAll("*")].filter((e) => e.shadowRoot);
  if ((root as Element).shadowRoot) hosts.push(root as Element);
  for (const h of hosts) text += ` ${deepText(h.shadowRoot as ShadowRoot)}`;
  return text;
}

function nameOf(el: Element): string {
  const attr = (n: string) => el.getAttribute(n)?.trim() ?? "";
  if (attr("aria-label")) return attr("aria-label");
  const labelled = attr("aria-labelledby");
  const scope = el.getRootNode() as Document | ShadowRoot;
  if (labelled) {
    const text = labelled
      .split(/\s+/)
      .map((id) => scope.getElementById?.(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }
  const id = el.getAttribute("id");
  const byFor = id ? scope.querySelector?.(`label[for="${id}"]`)?.textContent?.trim() : "";
  if (byFor) return byFor;
  const wrapping = el.closest("label")?.textContent?.trim();
  if (wrapping && el.tagName !== "BUTTON") return wrapping;
  if (attr("title")) return attr("title");
  const alt = el.querySelector("img[alt]")?.getAttribute("alt")?.trim();
  if (alt) return alt;
  if (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "tab")
    return el.textContent?.trim() ?? "";
  return "";
}

/** Descriptors of the controls that have no accessible name: the tag and the names of its data attributes, never any text. */
export function unnamedControls(root: ParentNode): string[] {
  return deepAll(root, CONTROLS)
    .filter((el) => nameOf(el) === "")
    .map((el) => {
      const tag = el.getAttribute("role") === "tab" ? "tab" : el.tagName.toLowerCase();
      const data = [...el.attributes]
        .filter((a) => a.name.startsWith("data-"))
        .map((a) => `[${a.name}]`)
        .join("");
      return `${tag}${data}`;
    });
}
