import { ContextProvider } from "@lit/context";
import { LitElement, css } from "lit";
import { html, unsafeStatic } from "lit/static-html.js";
import { type Route, parseRoute } from "../router";
import { type Services, createServices, servicesContext } from "../services";
import type { AuthState } from "../state/auth";
import { StoreController } from "../state/store";
import { baseStyles } from "../styles/base";
import { VIEWS } from "../views";
import "./dm-not-found";
import "./dm-toasts";

/** The root: provides the services, follows the router and draws the view of the current route. */
export class DmApp extends LitElement {
  static properties = { services: { attribute: false } };
  static styles = [
    baseStyles,
    css`:host { display: block; height: 100%; } .boot { padding: 32px; color: var(--dm-muted); }`,
  ];
  declare services: Services;
  private stopWatching: (() => void) | undefined;
  private provider: ContextProvider<typeof servicesContext> | undefined;
  private authState: StoreController<AuthState> | undefined;
  private route: StoreController<ReturnType<Services["router"]["get"]>> | undefined;

  connectedCallback() {
    this.services ??= createServices();
    // Controllers are created before super.connectedCallback(), so Lit connects them in the same call.
    this.provider ??= new ContextProvider(this, {
      context: servicesContext,
      initialValue: this.services,
    });
    this.route ??= new StoreController(this, this.services.router);
    this.authState ??= new StoreController(this, this.services.auth);
    super.connectedCallback();
    this.services.router.start();
    this.stopWatching = this.services.theme.watchSystem();
    this.addEventListener("click", this.onClick);
    if (this.services.auth.get().status === "unknown") void this.services.auth.bootstrap(); // never rejects
  }
  disconnectedCallback() {
    this.removeEventListener("click", this.onClick);
    this.services.router.stop();
    this.stopWatching?.();
    this.stopWatching = undefined;
    super.disconnectedCallback();
  }
  /** A plain click on a same-origin link navigates inside the app; modified clicks, other targets and other origins stay the browser's. */
  private readonly onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    const a = e.composedPath().find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement);
    if (!a || a.target !== "" || a.hasAttribute("download")) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || url.hash !== "") return;
    const route = parseRoute(url.pathname, url.search);
    if (route.name === "not-found") return; // unknown paths and /api/* are the browser's
    e.preventDefault();
    this.services.router.navigate(route);
  };
  /** What to draw and where to go, from the session and the route alone. */
  private decide(): { wait: boolean; to?: Route } {
    const state = this.services.auth.get();
    if (state.status === "unknown") return { wait: true };
    const name = this.services.router.get().name;
    const open = name === "sign-in" || name === "sign-up" || name === "account-deleted";
    if (state.status === "anonymous" && !open) return { wait: false, to: { name: "sign-in" } };
    if (state.status === "signed-in" && (name === "sign-in" || name === "sign-up"))
      return { wait: false, to: { name: "chat" } };
    return { wait: false };
  }
  /** The redirect happens before render, inside the running update: one render, and render sees the new route. */
  willUpdate() {
    const { to } = this.decide();
    if (to) this.services.router.navigate(to, { replace: true });
  }
  render() {
    const { wait, to } = this.decide();
    // The view is a nested part and dm-toasts sits outside it, so the live regions survive every view change.
    return html`${wait || to ? this.busy() : this.view()}<dm-toasts></dm-toasts>`;
  }
  /** Until the session is known (or for a render that should not happen after a redirect), nothing of any view is drawn. */
  private busy() {
    return html`<div class="boot" role="status" aria-busy="true">Loading…</div>`;
  }
  private view() {
    const route = this.route?.value ?? this.services.router.get();
    const tag = unsafeStatic(VIEWS[route.name] ?? "dm-not-found"); // the tag comes from our own table, never from the URL
    return route.name === "sign-in" || route.name === "sign-up"
      ? html`<${tag} mode=${route.name}></${tag}>`
      : html`<${tag}></${tag}>`;
  }
}
customElements.define("dm-app", DmApp);
