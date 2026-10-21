import { LitElement, css, html } from "lit";
import { ServicesController } from "../state/services-controller";
import type { Toast } from "../state/toasts";
import { baseStyles } from "../styles/base";
import "./dm-icon";

export class DmToasts extends LitElement {
  static properties = {};
  static styles = [
    baseStyles,
    css`
      :host { position: fixed; right: 24px; bottom: 24px; z-index: 10; display: grid; gap: 8px; max-width: min(420px, calc(100vw - 32px)); }
      [data-toast] { display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 14px; border-radius: var(--dm-radius-md); background: var(--dm-surface); box-shadow: var(--dm-shadow-md); font-size: 13.5px; }
      .region { display: grid; gap: 8px; }
      .lead { font-size: 18px; }
      [data-kind="ok"] .lead { color: var(--dm-ok); }
      [data-kind="err"] .lead { color: var(--dm-err); }
      .text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    `,
  ];
  private readonly ctx = new ServicesController(this, (s) => [s.toasts]);
  render() {
    const toasts = this.ctx.services?.toasts;
    const all = toasts?.get() ?? [];
    // Both live regions exist from the first render, so a screen reader is already listening when a toast arrives.
    return html`
      <div class="region" role="status" aria-atomic="false">${all.filter((t) => t.kind !== "err").map((t) => this.item(t))}</div>
      <div class="region" role="alert" aria-atomic="false">${all.filter((t) => t.kind === "err").map((t) => this.item(t))}</div>`;
  }
  private item(t: Toast) {
    const toasts = this.ctx.services?.toasts;
    return html`<div data-toast data-kind=${t.kind}>
        <dm-icon class="lead" name=${t.kind === "ok" ? "check-circle" : "warning-circle"}></dm-icon>
        <span class="text">${t.text}</span>
        ${
          t.action
            ? html`<button class="btn ghost" @click=${() => {
                t.action?.run();
                toasts?.dismiss(t.id);
              }}>${t.action.label}</button>`
            : null
        }
        <button class="btn icon" aria-label="Dismiss" @click=${() => toasts?.dismiss(t.id)}><dm-icon name="x"></dm-icon></button>
      </div>`;
  }
}
customElements.define("dm-toasts", DmToasts);
