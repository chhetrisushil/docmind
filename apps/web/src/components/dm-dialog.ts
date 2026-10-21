import { LitElement, type PropertyValues, css, html } from "lit";
import { baseStyles } from "../styles/base";

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/** The element that has focus, looking through open shadow roots. */
export function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

let ids = 0;
/** Open dialogs, oldest first: only the last one (the topmost) answers keys. */
const stack: DmDialog[] = [];
/** Key events a dialog has already answered: the panel and the document both see a composed event. */
const answered = new WeakSet<Event>();

/** The parent of `node` in the flat tree: where it is drawn, not where it is written. */
function flatParent(node: Node): Node | null {
  const native = (node as Element).assignedSlot;
  if (native) return native;
  // Environments without `assignedSlot`: ask the parent's shadow root which slot holds this node.
  const host = node.parentNode;
  if (host instanceof Element && host.shadowRoot)
    for (const slot of Array.from(host.shadowRoot.querySelectorAll("slot")))
      if (slot.assignedNodes({ flatten: true }).includes(node as ChildNode)) return slot;
  return host;
}

function hidden(el: HTMLElement): boolean {
  if (el.hidden || el.inert || el.closest("[inert]")) return true;
  const style = getComputedStyle(el);
  return style.display === "none" || style.visibility === "hidden";
}

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
      /* buttons a caller slots in from the light DOM (confirmDialog) do not see the shadow-scoped base styles */
      ::slotted(.btn) { font: inherit; min-height: 32px; padding: 5.6px 10px; border-radius: var(--dm-radius-md); border: 1px solid var(--dm-divider); background: transparent; color: var(--dm-text); cursor: pointer; }
      ::slotted(.btn.primary) { color: var(--dm-accent); border-color: var(--dm-accent); }
      ::slotted(.btn.danger) { color: var(--dm-err); border-color: var(--dm-err); }
    `,
  ];
  declare heading: string;
  declare open: boolean;
  declare persistent: boolean;
  private readonly titleId = `dm-dialog-title-${++ids}`;
  private readonly bodyId = `dm-dialog-body-${ids}`;
  private opener: Element | null = null;
  private inerted: HTMLElement[] = [];
  private watcher: MutationObserver | undefined;
  private downOnBackdrop = false;
  private active = false;

  constructor() {
    super();
    this.heading = "";
    this.open = false;
    this.persistent = false;
  }

  connectedCallback() {
    super.connectedCallback();
    if (this.open && this.hasUpdated && !this.active) {
      this.activate();
      this.moveFocusIn();
    }
  }
  disconnectedCallback() {
    if (this.active) this.deactivate(true);
    super.disconnectedCallback();
  }

  /** Starts answering keys, hides everything else, and remembers who had focus. */
  private activate() {
    this.active = true;
    stack.push(this);
    document.addEventListener("keydown", this.onKey);
    this.opener ??= deepActiveElement();
    this.isolate();
  }
  private deactivate(giveFocusBack: boolean) {
    this.active = false;
    const at = stack.indexOf(this);
    if (at >= 0) stack.splice(at, 1);
    document.removeEventListener("keydown", this.onKey);
    this.release();
    const opener = this.opener as HTMLElement | null;
    this.opener = null;
    if (giveFocusBack && opener?.isConnected) opener.focus?.();
  }

  /**
   * Everything outside the dialog stops taking focus and clicks and leaves the accessibility tree. The walk follows the flat
   * tree (slots included), level by level up through shadow roots, and keeps watching: nodes added later are hidden too.
   */
  private isolate() {
    this.watcher = new MutationObserver(() => this.hideOthers());
    this.hideOthers();
  }
  private hideOthers() {
    let node: Node = this;
    while (node && node !== document.documentElement) {
      const parent = flatParent(node);
      if (!parent || parent === document) break;
      const siblings: Node[] =
        parent instanceof HTMLSlotElement
          ? parent.assignedNodes({ flatten: true })
          : Array.from(parent.childNodes);
      this.watcher?.observe(node.parentNode ?? parent, { childList: true });
      if (parent !== node.parentNode) this.watcher?.observe(parent, { childList: true });
      for (const sib of siblings) {
        if (sib === node || !(sib instanceof HTMLElement) || sib.inert) continue;
        if (sib.localName === "script" || sib.localName === "style") continue;
        if (sib.hasAttribute("data-dialog-live")) continue; // live regions keep announcing
        sib.inert = true;
        this.inerted.push(sib);
      }
      node = parent instanceof ShadowRoot ? parent.host : parent;
    }
  }
  private release() {
    this.watcher?.disconnect();
    this.watcher = undefined;
    for (const el of this.inerted) el.inert = false;
    this.inerted = [];
  }

  private close() {
    this.dispatchEvent(new CustomEvent("dm-close"));
  }

  /** Tabbable elements in drawing order, through slots and open shadow roots; hidden, inert, disabled and nested-dialog content is skipped. */
  private focusables(): HTMLElement[] {
    const out: HTMLElement[] = [];
    const visit = (node: Node) => {
      if (!(node instanceof HTMLElement)) return;
      if (node instanceof DmDialog && node !== this) return;
      if (hidden(node)) return;
      if (node.matches(FOCUSABLE)) out.push(node);
      if (node instanceof HTMLSlotElement) {
        const assigned = node.assignedNodes({ flatten: true });
        for (const n of assigned.length ? assigned : Array.from(node.childNodes)) visit(n);
        return;
      }
      if (node.shadowRoot) for (const n of Array.from(node.shadowRoot.children)) visit(n);
      else for (const n of Array.from(node.children)) visit(n);
    };
    for (const n of Array.from(this.shadowRoot?.querySelectorAll(".panel > *") ?? [])) visit(n);
    return out;
  }
  private inside(node: Node | null): boolean {
    for (let n: Node | null = node; n; n = flatParent(n) ?? (n as ShadowRoot).host ?? null)
      if (n === this) return true;
    return false;
  }
  private moveFocusIn() {
    const items = this.focusables();
    const target = items.find((e) => e.hasAttribute("autofocus")) ?? items[0];
    (target ?? this.shadowRoot?.querySelector<HTMLElement>(".panel"))?.focus();
  }
  private readonly onKey = (e: KeyboardEvent) => {
    if (answered.has(e) || stack[stack.length - 1] !== this) return;
    if (e.key === "Escape") {
      answered.add(e);
      e.preventDefault();
      e.stopPropagation();
      return this.close();
    }
    if (e.key !== "Tab") return;
    answered.add(e);
    e.stopPropagation();
    const items = this.focusables();
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      e.preventDefault();
      this.shadowRoot?.querySelector<HTMLElement>(".panel")?.focus();
      return;
    }
    const current = deepActiveElement();
    const known = current !== null && items.includes(current as HTMLElement);
    if (e.shiftKey && (current === first || !known)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (current === last || !known)) {
      e.preventDefault();
      first.focus();
    }
  };
  private readonly onBackdropDown = (e: MouseEvent) => {
    this.downOnBackdrop = e.target === e.currentTarget;
    if (!this.downOnBackdrop) return;
    e.preventDefault(); // a click on the dim area must not move focus to the body
    if (!this.inside(deepActiveElement())) this.moveFocusIn();
  };
  private readonly onBackdropClick = (e: MouseEvent) => {
    const clean = this.downOnBackdrop && e.target === e.currentTarget;
    this.downOnBackdrop = false;
    if (clean && !this.persistent) this.close();
  };
  protected updated(changed: PropertyValues<this>) {
    if (!changed.has("open")) return;
    if (this.open && !this.active) {
      this.activate();
      this.moveFocusIn();
    } else if (!this.open && this.active) this.deactivate(true);
  }
  render() {
    if (!this.open) return html``;
    return html`
      <div class="backdrop" @mousedown=${this.onBackdropDown} @click=${this.onBackdropClick}>
        <div class="panel" role="dialog" aria-modal="true" aria-labelledby=${this.titleId} aria-describedby=${this.bodyId} tabindex="-1" @keydown=${this.onKey}>
          <h2 id=${this.titleId}>${this.heading}</h2>
          <div class="body" id=${this.bodyId}><slot></slot></div>
          <div class="actions"><slot name="actions"></slot></div>
        </div>
      </div>`;
  }
}
customElements.define("dm-dialog", DmDialog);
