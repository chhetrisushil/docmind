import { SignUpRequest } from "@docmind/contracts";
import { LitElement, css, html } from "lit";
import { ApiError } from "../api/http";
import { authErrorText } from "../state/auth";
import { ServicesController } from "../state/services-controller";
import { baseStyles } from "../styles/base";
import "./dm-icon";

export class DmAuthForm extends LitElement {
  static properties = {
    mode: { type: String },
    email: { state: true },
    password: { state: true },
    shown: { state: true },
    busy: { state: true },
    problem: { state: true },
  };
  static styles = [
    baseStyles,
    css`
      :host { display: grid; place-items: center; min-height: 100%; padding: 32px 16px; }
      form { width: min(400px, 100%); display: grid; gap: 16px; }
      h1 { font-size: 30px; margin-bottom: 4px; }
      .field { position: relative; }
      .reveal { position: absolute; right: 2px; top: 22px; }
      .hint { font-size: 12px; color: var(--dm-muted); margin-top: 4px; }
      .btn.primary { min-height: 40px; }
      p.switch { color: var(--dm-muted); }
    `,
  ];
  declare mode: "sign-in" | "sign-up";
  declare email: string;
  declare password: string;
  declare shown: boolean;
  declare busy: boolean;
  declare problem: string | undefined;
  private readonly ctx = new ServicesController(this);
  constructor() {
    super();
    this.mode = "sign-in";
    this.email = "";
    this.password = "";
    this.shown = false;
    this.busy = false;
  }
  /** A failed attempt leaves nothing secret behind: the field is emptied and the text hidden again. */
  private fail(problem: string): void {
    this.problem = problem;
    this.password = "";
    this.shown = false;
  }
  private async submit(e: Event) {
    e.preventDefault(); // first: the credentials must never fall back to a GET with a query string
    const auth = this.ctx.services?.auth;
    const router = this.ctx.services?.router;
    if (!auth || !router || this.busy) return;
    this.problem = undefined;
    if (this.mode === "sign-up") {
      const ok = SignUpRequest.safeParse({ email: this.email, password: this.password });
      if (!ok.success) {
        this.fail(
          this.password.length < 12 ? "At least 12 characters." : "Enter a valid email address.",
        );
        return;
      }
    }
    this.busy = true;
    try {
      if (this.mode === "sign-up")
        await auth.signUp({ email: this.email, password: this.password });
      else await auth.login({ email: this.email, password: this.password });
      this.password = "";
      router.navigate({ name: "chat" }, { replace: true });
    } catch (err) {
      // Sign-up answers 202 either way, so a refused sign-in after it must not say whether the address exists.
      this.fail(
        this.mode === "sign-up" && err instanceof ApiError && err.status === 401
          ? "We could not sign you in. If you already have an account, sign in instead."
          : authErrorText(err),
      );
    } finally {
      this.busy = false;
    }
  }
  private onEmail(e: Event): void {
    this.email = (e.target as HTMLInputElement).value;
  }
  private onPassword(e: Event): void {
    this.password = (e.target as HTMLInputElement).value;
  }
  private toggleShown(): void {
    this.shown = !this.shown;
  }
  render() {
    const up = this.mode === "sign-up";
    const invalid = this.problem !== undefined;
    return html`
      <form @submit=${this.submit} novalidate>
        <div>
          <h1>${up ? "Create your account" : "Sign in"}</h1>
          <p class="muted">${up ? "Your documents stay private to you." : "Welcome back."}</p>
        </div>
        <div>
          <label for="email">Email</label>
          <input class="input" id="email" name="email" type="email" autocomplete="email" required aria-invalid=${invalid} .value=${this.email} @input=${this.onEmail} />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input class="input" id="password" name="password" type=${this.shown ? "text" : "password"} autocomplete=${up ? "new-password" : "current-password"} required aria-invalid=${invalid} .value=${this.password} @input=${this.onPassword} />
          <button type="button" class="btn icon reveal" aria-label=${this.shown ? "Hide password" : "Show password"} @click=${this.toggleShown}><dm-icon name=${this.shown ? "eye-slash" : "eye"}></dm-icon></button>
          ${up ? html`<div class="hint">At least 12 characters</div>` : null}
        </div>
        ${this.problem ? html`<div class="error" role="alert"><dm-icon name="warning-circle"></dm-icon><span>${this.problem}</span></div>` : null}
        <button class="btn primary" type="submit" ?disabled=${this.busy}>${this.busy ? "One moment..." : up ? "Create account" : "Sign in"}</button>
        <p class="switch">${up ? html`Already have an account? <a href="/sign-in">Sign in</a>` : html`New to DocMind? <a href="/sign-up">Create an account</a>`}</p>
      </form>`;
  }
}
customElements.define("dm-auth-form", DmAuthForm);
