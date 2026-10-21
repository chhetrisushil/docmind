import { ContextProvider } from "@lit/context";
import { LitElement, css } from "lit";
import { html, unsafeStatic } from "lit/static-html.js";
import { parseRoute } from "../router";
import { type Services, createServices, servicesContext } from "../services";
import { StoreController } from "../state/store";
import { baseStyles } from "../styles/base";
import { VIEWS } from "../views";
import "./dm-not-found";
import "./dm-toasts";

/** The root: provides the services, follows the router and draws the view of the current route. */
export class DmApp extends LitElement {
  static properties = { services: { attribute: false } };
  static styles = [baseStyles, css`:host { display: block; height: 100%; }`];
  declare services: Services;
  private stopWatching: (() => void) | undefined;
  private provider: ContextProvider<typeof servicesContext> | undefined;
  private route: StoreController<ReturnType<Services["router"]["get"]>> | undefined;

  connectedCallback() {
    this.services ??= createServices();
    // Controllers are created before super.connectedCallback(), so Lit connects them in the same call.
    this.provider ??= new ContextProvider(this, {
      context: servicesContext,
      initialValue: this.services,
    });
    this.route ??= new StoreController(this, this.services.router);
    super.connectedCallback();
    this.services.router.start();
    this.stopWatching = this.services.theme.watchSystem();
    this.addEventListener("click", this.onClick);
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
    if (url.origin !== location.origin) return;
    e.preventDefault();
    this.services.router.navigate(parseRoute(url.pathname, url.search));
  };
  render() {
    const route = this.route?.value ?? this.services.router.get();
    const tag = unsafeStatic(VIEWS[route.name] ?? "dm-not-found"); // the tag comes from our own table, never from the URL
    return html`<${tag}></${tag}><dm-toasts></dm-toasts>`;
  }
}
customElements.define("dm-app", DmApp);
