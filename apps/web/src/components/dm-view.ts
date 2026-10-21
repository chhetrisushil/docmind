import type { ViewName } from "@docmind/contracts";
import { LitElement, css, html } from "lit";
import { report } from "../report";
import { ServicesController } from "../state/services-controller";
import { baseStyles } from "../styles/base";
import { type ActionHandler, ViewSession } from "../ui/session";

/** Mounts one loom-ui experience: a view session, drawn by renderer-lit into this element's shadow root. Draws no data itself. */
export class DmView extends LitElement {
  static properties = {
    name: { type: String },
    params: { attribute: false },
    onAct: { attribute: false },
    phase: { state: true },
  };
  static styles = [
    baseStyles,
    css`:host { display: block; } [data-loading] { padding: 16px; color: var(--dm-muted); } [role="alert"] { padding: 16px; display: grid; gap: 8px; justify-items: start; }`,
  ];
  declare name: ViewName | undefined;
  declare params: Record<string, string | number> | undefined;
  declare onAct: ActionHandler | undefined;
  declare phase: "loading" | "ready" | "failed";
  session: ViewSession | undefined;
  private opened: string | undefined;
  private readonly ctx = new ServicesController(this);
  constructor() {
    super();
    this.phase = "loading";
  }

  protected updated(changed: Map<string, unknown>): void {
    if (this.ctx.services && this.name !== undefined && this.opened !== this.name) void this.open();
    else if (changed.has("params") && this.session && this.params)
      this.session.setParams(this.params);
  }

  private async open(): Promise<void> {
    const svc = this.ctx.services;
    const name = this.name;
    if (!svc || name === undefined) return;
    this.opened = name;
    this.session?.dispose();
    this.session = undefined;
    this.phase = "loading";
    try {
      const session = await ViewSession.open(svc.api, name, {
        onStale: () =>
          svc.toasts.push({
            kind: "err",
            text: "This view changed. It has been refreshed; try again.",
          }),
      });
      if (this.name !== name || !this.isConnected) return session.dispose();
      this.session = session;
      session.start(this.params);
      await this.updateComplete;
      session.mount(this.renderRoot.querySelector("#host") as HTMLElement, (a) => this.onAct?.(a));
      this.phase = "ready";
      this.dispatchEvent(
        new CustomEvent("view-ready", { detail: { session }, bubbles: true, composed: true }),
      );
    } catch (err) {
      report("view", err);
      this.phase = "failed"; // `opened` stays set: only "Try again" asks again, so a failing fetch cannot loop

      this.dispatchEvent(new CustomEvent("view-problem", { bubbles: true, composed: true }));
    }
  }

  disconnectedCallback(): void {
    this.session?.dispose();
    this.session = undefined;
    this.opened = undefined;
    super.disconnectedCallback();
  }

  render() {
    return html`
      ${this.phase === "loading" ? html`<p data-loading role="status">Loading...</p>` : null}
      ${
        this.phase === "failed"
          ? html`<div role="alert"><p>This section could not be loaded.</p><button class="btn secondary" data-retry @click=${() => {
              this.opened = undefined;
              this.requestUpdate();
            }}>Try again</button></div>`
          : null
      }
      <div id="host" part="host"></div>`;
  }
}
customElements.define("dm-view", DmView);
