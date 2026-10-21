import { LitElement, css, html } from "lit";
import { ApiError } from "../api/http";
import { ServicesController } from "../state/services-controller";
import { baseStyles } from "../styles/base";
import "./dm-icon";

export class DmAccountDeleted extends LitElement {
  static properties = {
    stateText: { state: true },
    checking: { state: true },
    done: { state: true },
  };
  static styles = [
    baseStyles,
    css`
      :host { display: grid; place-items: center; min-height: 100%; padding: 32px 16px; }
      main { width: min(520px, 100%); display: grid; gap: 14px; }
      h1 { font-size: 26px; }
      code { display: block; padding: 12px; border-radius: var(--dm-radius-md); background: var(--dm-surface); box-shadow: var(--dm-shadow-sm); overflow-wrap: anywhere; user-select: all; }
      .btn[aria-disabled="true"] { opacity: 0.45; cursor: default; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; }
    `,
  ];
  declare stateText: string | undefined;
  declare checking: boolean;
  declare done: boolean;
  private readonly ctx = new ServicesController(this, (s) => [s.receipt]);
  constructor() {
    super();
    this.checking = false;
    this.done = false;
  }
  protected firstUpdated() {
    this.renderRoot.querySelector<HTMLElement>("h1")?.focus(); // a route change moves no focus by itself
  }
  disconnectedCallback() {
    this.ctx.services?.receipt.set(undefined); // "gone when you leave this page"
    super.disconnectedCallback();
  }
  private async copy(receipt: string) {
    try {
      await navigator.clipboard.writeText(receipt);
      this.ctx.services?.toasts.push({ kind: "ok", text: "Receipt copied." });
    } catch {
      this.ctx.services?.toasts.push({
        kind: "err",
        text: "Could not copy. Select the receipt and copy it.",
      });
    }
  }
  private async check(receipt: string) {
    const api = this.ctx.services?.api;
    if (!api || this.checking || this.done) return;
    this.checking = true;
    try {
      const { state } = await api.erasureStatus(receipt);
      this.done = state === "done";
      this.stateText =
        state === "done"
          ? "Done. Your account and its data have been erased."
          : "In progress. Some of your data may remain until it finishes.";
    } catch (err) {
      this.stateText =
        err instanceof ApiError && err.status === 404
          ? "No deletion matches this receipt."
          : err instanceof ApiError && err.status === 0
            ? "Could not reach the server. Check your connection."
            : "Could not check right now. Try again.";
    } finally {
      this.checking = false;
    }
  }
  render() {
    const receipt = this.ctx.services?.receipt.get();
    return html`<main>
      <h1 tabindex="-1">Your account is being deleted</h1>
      ${
        receipt
          ? html`<p>Keep this receipt. It is the only way to check that the deletion has finished. It is shown once: it is not stored anywhere, and it is gone when you leave this page.</p>
          <code data-receipt>${receipt}</code>
          <div class="row">
            <button class="btn secondary" data-copy @click=${() => this.copy(receipt)}><dm-icon name="copy"></dm-icon>Copy receipt</button>
            <button class="btn primary" data-check aria-disabled=${this.checking || this.done} @click=${() => this.check(receipt)}>Check status</button>
          </div>
          <p data-state aria-live="polite">${this.stateText ?? ""}</p>`
          : html`<p>The receipt is no longer on this page, so it cannot be shown again. If you deleted your account, it is already unusable.</p>`
      }
      <p><a href="/sign-up">Create a new account</a></p>
    </main>`;
  }
}
customElements.define("dm-account-deleted", DmAccountDeleted);
