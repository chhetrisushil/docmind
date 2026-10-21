import { SignUpRequest } from "@docmind/contracts";
import { LitElement, css, html, nothing } from "lit";
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
    invalid: { state: true },
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
      .btn[aria-disabled="true"] { opacity: 0.45; cursor: default; }
      .btn[aria-disabled="true"] { opacity: 0.45; cursor: default; }
      p.switch { color: var(--dm-muted); }
    `,
  ];
  declare mode: "sign-in" | "sign-up";
  declare email: string;
  declare password: string;
  declare shown: boolean;
  declare busy: boolean;
  declare problem: string | undefined;
  /** Which fields the problem is about: none for a network or throttle error. */
  declare invalid: ReadonlySet<"email" | "password">;
  private readonly ctx = new ServicesController(this);
  constructor() {
    super();
    this.mode = "sign-in";
    this.email = "";
    this.password = "";
    this.shown = false;
    this.busy = false;
    this.invalid = new Set();
  }
  /**
   * A failed attempt leaves nothing secret behind: the field is emptied and the text hidden again. Focus goes to the
   * first field the problem is about, or to the message itself when it is about neither.
   */
  private async fail(
    problem: string,
    fields: ("email" | "password")[],
    focus?: "email" | "password",
  ) {
    this.problem = problem;
    this.invalid = new Set(fields);
    this.password = "";
    this.shown = false;
    await this.updateComplete;
    const target = focus
      ? this.renderRoot.querySelector(`input[name=${focus}]`)
      : this.renderRoot.querySelector("#problem");
    (target as HTMLElement | null)?.focus();
  }
  private async submit(e: Event) {
    e.preventDefault(); // first: the credentials must never fall back to a GET with a query string
    const auth = this.ctx.services?.auth;
    const router = this.ctx.services?.router;
    if (!auth || !router || this.busy) return;
    this.problem = undefined;
    this.invalid = new Set();
    const email = this.email.trim();
    if (this.mode === "sign-up") {
      const ok = SignUpRequest.safeParse({ email, password: this.password });
      if (!ok.success) {
        if (this.password.length < 12)
          await this.fail("At least 12 characters.", ["password"], "password");
        else await this.fail("Enter a valid email address.", ["email"], "email");
        return;
      }
    }
    this.busy = true;
    try {
      if (this.mode === "sign-up") await auth.signUp({ email, password: this.password });
      else await auth.login({ email, password: this.password });
      this.password = "";
      router.navigate({ name: "chat" }, { replace: true });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined;
      this.busy = false;
      if (this.mode === "sign-up" && status === 401)
        // Sign-up answers 202 either way, so a refused sign-in after it must not say whether the address exists.
        await this.fail(
          "We could not sign you in. If you already have an account, sign in instead.",
          [],
        );
      else if (status === 401)
        await this.fail(authErrorText(err), ["email", "password"], "password");
      else if (status === 400) await this.fail(authErrorText(err), ["email", "password"], "email");
      else await this.fail(authErrorText(err), []);
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
    const bad = (f: "email" | "password") => this.problem !== undefined && this.invalid.has(f);
    const about = (f: "email" | "password", extra?: string) =>
      [extra, bad(f) ? "problem" : undefined].filter(Boolean).join(" ") || nothing;
    return html`
      <form @submit=${this.submit} method="post" novalidate>
        <div>
          <h1>${up ? "Create your account" : "Sign in"}</h1>
          <p class="muted">${up ? "Your documents stay private to you." : "Welcome back."}</p>
        </div>
        <div>
          <label for="email">Email</label>
          <input class="input" id="email" name="email" type="email" autocomplete=${up ? "email" : "username"} autocapitalize="off" spellcheck="false" required aria-invalid=${bad("email")} aria-describedby=${about("email")} .value=${this.email} @input=${this.onEmail} />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input class="input" id="password" name="password" type=${this.shown ? "text" : "password"} autocomplete=${up ? "new-password" : "current-password"} required aria-invalid=${bad("password")} aria-describedby=${about("password", up ? "pw-hint" : undefined)} .value=${this.password} @input=${this.onPassword} />
          <button type="button" class="btn icon reveal" aria-label=${this.shown ? "Hide password" : "Show password"} @click=${this.toggleShown}><dm-icon name=${this.shown ? "eye-slash" : "eye"}></dm-icon></button>
          ${up ? html`<div class="hint" id="pw-hint">At least 12 characters</div>` : null}
        </div>
        ${this.problem ? html`<div class="error" id="problem" role="alert" tabindex="-1"><dm-icon name="warning-circle"></dm-icon><span>${this.problem}</span></div>` : null}
        <button class="btn primary" type="submit" aria-disabled=${this.busy} aria-busy=${this.busy}>${this.busy ? "One moment..." : up ? "Create account" : "Sign in"}</button>
        <p class="switch">${up ? html`Already have an account? <a href="/sign-in">Sign in</a>` : html`New to DocMind? <a href="/sign-up">Create an account</a>`}</p>
      </form>`;
  }
}
customElements.define("dm-auth-form", DmAuthForm);
