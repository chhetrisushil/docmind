import { LitElement, css, html, nothing } from "lit";
import { ApiError } from "../api/http";
import { authErrorText } from "../state/auth";
import { ServicesController } from "../state/services-controller";
import type { ThemeChoice } from "../state/theme";
import { baseStyles } from "../styles/base";
import "./dm-dialog";
import "./dm-icon";

const MAYBE = "The deletion may have been accepted. Use Check status to find out.";

/** Whether the request may have reached the server and been accepted although no answer came back. */
function uncertain(err: unknown): boolean {
  return !(err instanceof ApiError) || !(err.status === 401 || err.status === 429);
}

function deleteErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "The password is not right.";
    if (err.status === 429) return authErrorText(err);
    if (err.status === 0) return `Could not reach the server. ${MAYBE}`;
  }
  return `Something went wrong. ${MAYBE}`;
}

export class DmSettings extends LitElement {
  static properties = {
    confirming: { state: true },
    password: { state: true },
    busy: { state: true },
    problem: { state: true },
    wrongPassword: { state: true },
    unsure: { state: true },
  };
  static styles = [
    baseStyles,
    css`
      :host { display: block; padding: 28px 40px; max-width: 720px; }
      h1 { font-size: 26px; margin-bottom: 20px; }
      section { padding: 16px 0; border-top: 1px solid var(--dm-divider); display: grid; gap: 10px; }
      h2 { font-size: 16px; }
      .btn[aria-disabled="true"] { opacity: 0.45; cursor: default; }
      .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      select { min-height: 36px; border-radius: var(--dm-radius-md); background: var(--dm-surface); color: var(--dm-text); border: 1px solid var(--dm-divider); padding: 0 8px; font: inherit; }
    `,
  ];
  declare confirming: boolean;
  declare password: string;
  declare busy: boolean;
  declare problem: string | undefined;
  /** True only when the server said the password is wrong: the one case where the field is the thing at fault. */
  declare wrongPassword: boolean;
  /** The answer to the delete request was lost or unclear: it may have been accepted. */
  declare unsure: boolean;
  private readonly ctx = new ServicesController(this, (s) => [s.auth, s.theme]);
  constructor() {
    super();
    this.confirming = false;
    this.password = "";
    this.busy = false;
    this.wrongPassword = false;
    this.unsure = false;
  }
  private async signOut() {
    const svc = this.ctx.services;
    if (!svc) return;
    await svc.auth.logout();
    svc.router.navigate({ name: "sign-in" }, { replace: true });
  }
  private async confirmDelete(e: Event) {
    e.preventDefault();
    const svc = this.ctx.services;
    if (!svc || this.busy || this.password === "") return;
    this.busy = true;
    this.problem = undefined;
    this.wrongPassword = false;
    this.unsure = false;
    try {
      const done = await svc.api.deleteAccount({ password: this.password });
      this.password = "";
      this.confirming = false;
      svc.receipt.set(done.receipt); // memory only: never logged, stored or put in a toast or the URL
      // To the public receipt page first, so the route guard has nothing to redirect when the session ends.
      svc.router.navigate({ name: "account-deleted" }, { replace: true });
      svc.auth.signedOut();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Already being deleted: this browser is done, and the receipt of that request is not ours to show.
        this.password = "";
        this.confirming = false;
        svc.router.navigate({ name: "account-deleted" }, { replace: true });
        svc.auth.signedOut();
        return;
      }
      this.unsure = uncertain(err);
      this.wrongPassword = err instanceof ApiError && err.status === 401;
      this.problem = deleteErrorText(err);
      this.password = "";
      await this.updateComplete;
      this.renderRoot.querySelector<HTMLElement>("dm-dialog input[type=password]")?.focus();
    } finally {
      this.busy = false;
    }
  }
  /** After a lost answer: a session that still works means nothing was deleted; one that ended means it was accepted. */
  private async checkStatus() {
    const svc = this.ctx.services;
    if (!svc || this.busy) return;
    this.busy = true;
    try {
      await svc.api.me();
      this.problem = "Your account is still active, so nothing was deleted. Try again.";
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        this.password = "";
        this.confirming = false;
        svc.router.navigate({ name: "account-deleted" }, { replace: true });
        svc.auth.signedOut();
        return;
      }
      this.problem = "Could not check right now. Try again.";
    } finally {
      this.busy = false;
    }
  }
  private openDialog() {
    this.confirming = true;
  }
  private closeDialog() {
    if (this.busy) return; // a deletion in flight cannot be dismissed half-way
    this.confirming = false;
    this.password = "";
    this.problem = undefined;
    this.wrongPassword = false;
    this.unsure = false;
  }
  private onPassword(e: Event) {
    this.password = (e.target as HTMLInputElement).value;
  }
  private onTheme(e: Event) {
    this.ctx.services?.theme.choose((e.target as HTMLSelectElement).value as ThemeChoice);
  }
  render() {
    const svc = this.ctx.services;
    const state = svc?.auth.get();
    return html`
      <h1>Settings</h1>
      <section aria-labelledby="account">
        <h2 id="account">Account</h2>
        <div class="row"><span>Signed in as <strong data-email>${state?.status === "signed-in" ? state.me.email : ""}</strong></span>
          <button class="btn secondary" data-sign-out @click=${this.signOut}><dm-icon name="sign-out"></dm-icon>Sign out</button></div>
      </section>
      <section aria-labelledby="appearance">
        <h2 id="appearance">Appearance</h2>
        <div class="row"><span>Theme</span>
          <select aria-label="Theme" .value=${svc?.theme.get() ?? "system"} @change=${this.onTheme}>
            <option value="system">Match system</option><option value="dark">Dark</option><option value="light">Light</option>
          </select></div>
      </section>
      <section aria-labelledby="danger">
        <h2 id="danger">Delete account</h2>
        <p class="muted">Permanently deletes your account, your documents and your chats.</p>
        <div><button class="btn danger" data-delete @click=${this.openDialog}>Delete my account</button></div>
      </section>
      <dm-dialog heading="Delete your account?" ?open=${this.confirming} persistent @dm-close=${this.closeDialog}>
        <form id="delete-form" @submit=${this.confirmDelete}>
          <p>This deletes your account, all your documents and all your chats. This cannot be undone. Your data is made unreadable first and then removed, which can take a little while if an answer is still being written.</p>
          <label for="del-pw">Enter your password to confirm</label>
          <input class="input" id="del-pw" name="password" type="password" autocomplete="current-password" autofocus aria-invalid=${this.wrongPassword} aria-describedby=${this.problem ? "del-problem" : nothing} .value=${this.password} @input=${this.onPassword} />
          ${this.problem ? html`<div class="error" id="del-problem" role="alert"><dm-icon name="warning-circle"></dm-icon><span>${this.problem}</span></div>` : null}
        </form>
        ${this.unsure ? html`<button slot="actions" type="button" class="btn secondary" data-status aria-disabled=${this.busy} @click=${this.checkStatus}>Check status</button>` : nothing}
        <button slot="actions" type="button" class="btn secondary" data-cancel aria-disabled=${this.busy} @click=${this.closeDialog}>Cancel</button>
        <button slot="actions" type="submit" form="delete-form" class="btn danger" data-confirm aria-disabled=${this.busy || this.password === ""} aria-busy=${this.busy} @click=${this.confirmDelete}>${this.busy ? "Deleting..." : "Delete my account"}</button>
      </dm-dialog>`;
  }
}
customElements.define("dm-settings", DmSettings);
