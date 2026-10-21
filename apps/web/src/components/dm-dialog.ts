import { LitElement, type PropertyValues, css, html } from "lit";
import { baseStyles } from "../styles/base";

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** The element that has focus, looking through open shadow roots. */
export function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

let ids = 0;

export class DmDialog extends LitElement {
  static properties = {
    heading: { type: String },
    open: { type: Boolean, reflect: true },
    persistent: { type: Boolean },
  };
  static styles = [
    baseStyles,
    css`
      .backdrop { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 16px; background: color-mix(in srgb, var(--dm-neutral-900) 50%, transparent); }
      .panel { width: min(440px, 100%); max-height: 100%; overflow: auto; padding: 22px; border-radius: var(--dm-radius-lg); background: var(--dm-surface); box-shadow: var(--dm-shadow-lg); display: grid; gap: 14px; }
      h2 { font-size: 20px; }
      .body { font-size: 14px; display: grid; gap: 12px; }
      .actions { display: flex; justify-content: flex-end; gap: 8px; }
    `,
  ];
  declare heading: string;
  declare open: boolean;
  declare persistent: boolean;
  private readonly titleId = `dm-dialog-title-${++ids}`;
  private opener: Element | null = null;
  private inerted: HTMLElement[] = [];

  constructor() {
    super();
    this.heading = "";
    this.open = false;
    this.persistent = false;
  }

  /** Everything outside the dialog stops taking focus and clicks and leaves the accessibility tree, level by level up through shadow roots. */
  private isolate() {
    this.release();
    let node: Node = this;
    while (node && node !== document.documentElement) {
      const parent: Node | null = node.parentNode;
      if (!parent) break;
      for (const sib of Array.from(parent.childNodes)) {
        if (sib === node || !(sib instanceof HTMLElement) || sib.inert) continue;
        if (sib.localName === "script" || sib.localName === "style") continue;
        sib.inert = true;
        this.inerted.push(sib);
      }
      node = parent instanceof ShadowRoot ? parent.host : parent;
    }
  }
  private release() {
    for (const el of this.inerted) el.inert = false;
    this.inerted = [];
  }
  disconnectedCallback() {
    this.release();
    super.disconnectedCallback();
  }
  private close() {
    this.dispatchEvent(new CustomEvent("dm-close", { bubbles: true, composed: true }));
  }
  private focusables(): HTMLElement[] {
    const own = [...(this.shadowRoot?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const slotted = [...(this.shadowRoot?.querySelectorAll("slot") ?? [])].flatMap((s) =>
      s
        .assignedElements({ flatten: true })
        .flatMap((e) => [e as HTMLElement, ...e.querySelectorAll<HTMLElement>(FOCUSABLE)])
        .filter((e) => e.matches(FOCUSABLE)),
    );
    return [...slotted, ...own].filter((e) => !e.hasAttribute("disabled"));
  }
  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      return this.close();
    }
    if (e.key !== "Tab") return;
    const items = this.focusables();
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return e.preventDefault();
    const current = deepActiveElement();
    if (e.shiftKey && (current === first || !items.includes(current as HTMLElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (current === last || !items.includes(current as HTMLElement))) {
      e.preventDefault();
      first.focus();
    }
  }
  protected updated(changed: PropertyValues<this>) {
    if (!changed.has("open")) return;
    if (this.open) {
      this.opener = deepActiveElement();
      this.isolate();
      const target =
        this.focusables().find((e) => e.hasAttribute("autofocus")) ?? this.focusables()[0];
      (target ?? this.shadowRoot?.querySelector<HTMLElement>(".panel"))?.focus();
    } else if (changed.get("open") === true) {
      this.release();
      (this.opener as HTMLElement | null)?.focus?.();
      this.opener = null;
    }
  }
  render() {
    if (!this.open) return html``;
    return html`
      <div class="backdrop" @click=${() => !this.persistent && this.close()}>
        <div class="panel" role="dialog" aria-modal="true" aria-labelledby=${this.titleId} tabindex="-1" @click=${(e: Event) => e.stopPropagation()} @keydown=${this.onKey}>
          <h2 id=${this.titleId}>${this.heading}</h2>
          <div class="body"><slot></slot></div>
          <div class="actions"><slot name="actions"></slot></div>
        </div>
      </div>`;
  }
}
customElements.define("dm-dialog", DmDialog);
