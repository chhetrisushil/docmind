import { LitElement, css, html } from "lit";
import { ServicesController } from "../state/services-controller";
import { baseStyles } from "../styles/base";
import "./dm-icon";
import "./dm-sessions";

/** The frame of every signed-in page: a sidebar (with the chats list) and a main region for the view. */
export class DmAppShell extends LitElement {
  static properties = { menuOpen: { state: true } };
  static styles = [
    baseStyles,
    css`
      :host { display: flex; height: 100%; }
      aside { flex: none; width: var(--dm-sidebar-w); display: flex; flex-direction: column; background: var(--dm-side); border-right: 1px solid var(--dm-divider); min-height: 0; }
      header { display: flex; align-items: center; gap: 10px; padding: 14px 14px 10px; }
      .logo { width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; box-shadow: inset 0 0 0 1px var(--dm-accent); color: var(--dm-accent); }
      .brand { font-size: 14px; font-weight: 500; }
      .block { display: grid; gap: 4px; padding: 4px 12px 8px; }
      .block .btn { justify-content: flex-start; min-height: 36px; }
      a.nav { display: flex; align-items: center; gap: 10px; min-height: 34px; padding: 0 10px; border-radius: var(--dm-radius-md); color: inherit; text-decoration: none; }
      a.nav:hover { background: color-mix(in srgb, var(--dm-text) 7%, transparent); }
      a.nav[aria-current="page"] { background: var(--dm-accent-900); color: var(--dm-accent-200); }
      .list { flex: 1; min-height: 0; overflow: auto; padding: 0 6px; }
      footer { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--dm-divider); }
      [data-user] { flex: 1; min-width: 0; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      a.btn { color: var(--dm-muted); text-decoration: none; }
      main { flex: 1; min-width: 0; min-height: 0; overflow: auto; }
      main:focus { outline: none; }
      .skip { position: absolute; left: 8px; top: 8px; z-index: 20; padding: 8px 12px; border-radius: var(--dm-radius-md); background: var(--dm-surface); color: var(--dm-text); box-shadow: var(--dm-shadow-md); transform: translateY(-200%); }
      .skip:focus { transform: none; }
      .menu { display: none; }
      @media (max-width: 800px) {
        aside { position: fixed; inset: 0 auto 0 0; z-index: 5; transform: translateX(-100%); visibility: hidden; }
        aside[data-open] { transform: none; visibility: visible; box-shadow: var(--dm-shadow-lg); }
        .menu { display: inline-flex; position: fixed; top: 8px; left: 8px; z-index: 6; background: var(--dm-surface); }
      }
    `,
  ];
  declare menuOpen: boolean;
  private readonly ctx = new ServicesController(this, (s) => [s.router, s.auth, s.theme]);
  constructor() {
    super();
    this.menuOpen = false;
  }
  private async signOut() {
    const svc = this.ctx.services;
    if (!svc) return;
    await svc.auth.logout();
    svc.router.navigate({ name: "sign-in" }, { replace: true });
  }
  private route: unknown;
  protected willUpdate(): void {
    const route = this.ctx.services?.router.get();
    if (this.route !== undefined && route !== this.route && this.menuOpen) {
      // any route change closes the overlay; focus that was inside it would fall to the body, so it goes to the Menu button
      const inside = this.renderRoot.querySelector("aside");
      this.refocus = inside?.contains(this.shadowRoot?.activeElement ?? null) === true;
      this.menuOpen = false;
    }
    this.route = route;
  }
  private refocus = false;
  protected updated(changed: Map<string, unknown>): void {
    if (this.refocus) {
      this.refocus = false;
      this.renderRoot.querySelector<HTMLElement>("[data-menu]")?.focus();
    }
    if (changed.get("menuOpen") === false && this.menuOpen)
      this.renderRoot.querySelector<HTMLElement>("#sidebar [data-new-chat]")?.focus();
  }
  private toggleMenu() {
    this.menuOpen = !this.menuOpen;
  }
  private newChat() {
    this.ctx.services?.router.navigate({ name: "chat" });
    this.menuOpen = false;
  }
  private onMenuKey(e: KeyboardEvent) {
    if (e.key !== "Escape" || !this.menuOpen) return;
    this.menuOpen = false;
    this.renderRoot.querySelector<HTMLElement>("[data-menu]")?.focus();
  }
  /** An in-page anchor cannot reach into a shadow root, so the skip link moves focus itself. */
  private skip(e: Event) {
    e.preventDefault();
    this.renderRoot.querySelector<HTMLElement>("main")?.focus();
  }
  private toggleTheme() {
    const light = document.documentElement.dataset.theme === "light";
    this.ctx.services?.theme.choose(light ? "dark" : "light");
  }
  render() {
    const svc = this.ctx.services;
    const route = svc?.router.get();
    const auth = svc?.auth.get();
    const light = document.documentElement.dataset.theme === "light";
    const here = route?.name === "documents" || route?.name === "document";
    return html`
      <a class="skip" data-skip href="#main" @click=${this.skip}>Skip to main content</a>
      <button class="btn secondary menu" data-menu aria-expanded=${this.menuOpen} aria-controls="sidebar" @click=${this.toggleMenu} @keydown=${this.onMenuKey}><dm-icon name="sidebar-simple"></dm-icon>Menu</button>
      <aside id="sidebar" ?data-open=${this.menuOpen} @keydown=${this.onMenuKey}>
        <header><span class="logo"><dm-icon name="book-open-text"></dm-icon></span><span class="brand">DocMind</span></header>
        <nav aria-label="Primary" class="block">
          <button class="btn primary" data-new-chat @click=${this.newChat}><dm-icon name="plus"></dm-icon>New chat</button>
          <a class="nav" data-documents href="/documents" aria-current=${here ? "page" : "false"}><dm-icon name="files"></dm-icon>Documents</a>
        </nav>
        <div class="list"><dm-sessions></dm-sessions></div>
        <footer>
          <span data-user>${auth?.status === "signed-in" ? auth.me.email : ""}</span>
          <a class="btn icon" href="/settings" aria-label="Settings"><dm-icon name="gear"></dm-icon></a>
          <button class="btn icon" data-theme-toggle aria-label="Toggle theme" @click=${this.toggleTheme}><dm-icon name=${light ? "moon" : "sun"}></dm-icon></button>
          <button class="btn icon" data-sign-out aria-label="Sign out" @click=${this.signOut}><dm-icon name="sign-out"></dm-icon></button>
        </footer>
      </aside>
      <main id="main" tabindex="-1" ?inert=${this.menuOpen}><slot></slot></main>`;
  }
}
customElements.define("dm-app-shell", DmAppShell);
