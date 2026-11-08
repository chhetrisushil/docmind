import type { ViewName } from "@docmind/contracts";
import { LitElement, css, html } from "lit";
import type { ViewSource } from "../api/client";
import { report } from "../report";
import { ServicesController } from "../state/services-controller";
import { baseStyles } from "../styles/base";
import { type ActionHandler, ViewSession } from "../ui/session";

/** Mounts one loom-ui experience: a view session, drawn by renderer-lit into this element's shadow root. Draws no data itself. */
export class DmView extends LitElement {
  static properties = {
    name: { type: String },
    document: { type: String },
    params: { attribute: false },
    onAct: { attribute: false },
    phase: { state: true },
  };
  static styles = [
    baseStyles,
    css`:host { display: block; } [data-loading] { padding: 16px; color: var(--dm-muted); } [role="alert"] { padding: 16px; display: grid; gap: 8px; justify-items: start; }`,
    // `fill`: the experience takes this element's height and a Chat widget takes what the others leave,
    // so its log scrolls and the widgets after it (the composer) stay in view at the bottom. The root
    // layout is stacked as a column over the renderer's inline grid, which would share the height evenly.
    css`
      :host([fill]) { display: flex; flex-direction: column; min-height: 0; }
      :host([fill]) #host,
      :host([fill]) #host > [data-blueprint-id] { display: flex; flex-direction: column; flex: 1; min-height: 0; }
      :host([fill]) #host > [data-blueprint-id] > [data-layout] { display: flex !important; flex-direction: column !important; flex: 1; min-height: 0; }
      :host([fill]) #host > [data-blueprint-id] > [data-layout] > :not([data-widget-kind="Chat"]) { flex: none; }
      :host([fill]) [data-widget-kind="Chat"] { display: flex; flex-direction: column; flex: 1; min-height: 0; }
      :host([fill]) [data-widget-kind="Chat"] > * { flex: 1; min-height: 0; }
    `,
  ];
  declare name: ViewName | undefined;
  /** A document id: the view is that document's detail experience (instead of `name`). */
  declare document: string | undefined;
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

  private get source(): ViewSource | undefined {
    if (this.document !== undefined) return { document: this.document };
    return this.name === undefined ? undefined : { view: this.name };
  }

  protected updated(changed: Map<string, unknown>): void {
    const key = this.sourceKey();
    if (this.ctx.services && key !== undefined && this.opened !== key) void this.open();
    else if (changed.has("params") && this.session && this.params)
      this.session.setParams(this.params);
  }

  /** Bumped by every open and every disconnect: an await that finds it moved belongs to a view nobody wants any more. */
  private generation = 0;
  private fetching: AbortController | undefined;

  private sourceKey(): string | undefined {
    const source = this.source;
    return source === undefined
      ? undefined
      : "view" in source
        ? `view:${source.view}`
        : `document:${source.document}`;
  }

  private async open(): Promise<void> {
    const svc = this.ctx.services;
    const source = this.source;
    const key = this.sourceKey();
    if (!svc || source === undefined || key === undefined) return;
    const mine = ++this.generation;
    const current = () => mine === this.generation && this.isConnected;
    this.fetching?.abort();
    const ac = new AbortController();
    this.fetching = ac;
    this.opened = key;
    this.session?.dispose();
    this.session = undefined;
    this.phase = "loading";
    let session: ViewSession | undefined;
    try {
      session = await ViewSession.open(svc.api, source, {
        signal: ac.signal,
        onStale: () =>
          svc.toasts.push({
            kind: "err",
            text: "This view changed. It has been refreshed; try again.",
          }),
        onFailed: () => {
          if (this.session !== session) return;
          this.phase = "failed";
          this.dispatchEvent(new CustomEvent("view-problem", { bubbles: true, composed: true }));
        },
      });
      if (!current()) return session.dispose();
      this.session = session;
      session.start(this.params);
      await this.updateComplete;
      if (!current()) return this.drop(session);
      session.mount(this.renderRoot.querySelector("#host") as HTMLElement, (a) => this.onAct?.(a));
      this.phase = "ready";
      this.dispatchEvent(
        new CustomEvent("view-ready", { detail: { session }, bubbles: true, composed: true }),
      );
    } catch (err) {
      this.drop(session);
      if (!current()) return; // nobody is waiting for this answer
      report("view", err);
      this.phase = "failed"; // `opened` stays set: only "Try again" asks again, so a failing fetch cannot loop
      this.dispatchEvent(new CustomEvent("view-problem", { bubbles: true, composed: true }));
    }
  }

  private drop(session: ViewSession | undefined): void {
    if (this.session === session) this.session = undefined;
    session?.dispose();
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated) this.requestUpdate(); // a reconnect opens the view again
  }

  disconnectedCallback(): void {
    this.generation += 1;
    this.fetching?.abort();
    this.fetching = undefined;
    const session = this.session;
    this.session = undefined;
    this.opened = undefined;
    try {
      session?.dispose();
    } catch (err) {
      report("view", err);
    } finally {
      super.disconnectedCallback();
    }
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
