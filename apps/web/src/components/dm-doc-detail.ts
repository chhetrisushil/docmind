import { type Intent, intentOf } from "@docmind/contracts";
import { LitElement, css, html } from "lit";
import { ServicesController } from "../state/services-controller";
import { baseStyles } from "../styles/base";
import { performIntent } from "../surface/perform";
import type { ActionHandler, ViewSession } from "../ui/session";
import { confirmDialog } from "./confirm";
import "./dm-icon";
import "./dm-view";

type Params = Record<string, string | number>;

/** One document: a header with its actions over the `detail` experience (status, then Summary / Analysis / Content tabs). It draws no data; it performs intents. */
export class DmDocDetail extends LitElement {
  static properties = {
    missing: { state: true },
    served: { state: true },
    failed: { state: true },
  };
  static styles = [
    baseStyles,
    css`
      :host { display: block; padding: 24px; max-width: 1000px; margin: 0 auto; }
      header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
      header .grow { flex: 1; }
      [data-not-found] { display: grid; gap: 8px; padding: 32px 0; justify-items: start; }
    `,
  ];
  declare missing: boolean;
  /** The server answered for this route's document: only then does the page hold its id. */
  declare served: boolean;
  declare failed: boolean;
  private readonly ctx = new ServicesController(this, (s) => [s.router]);
  private session: ViewSession | undefined;
  private unwatch: (() => void) | undefined;
  private upto = 20;
  private tabDone = false;
  private params: Params | undefined;
  private paramsKey = "";
  private seenKey = "";
  /** Aborted when the page leaves: a confirmation still open then answers no. */
  private leaving = new AbortController();
  constructor() {
    super();
    this.missing = false;
    this.served = false;
    this.failed = false;
  }
  private get route() {
    const r = this.ctx.services?.router.get();
    return r?.name === "document" ? r : undefined;
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.leaving.signal.aborted) this.leaving = new AbortController();
  }
  disconnectedCallback(): void {
    this.leaving.abort();
    this.unwatch?.();
    this.unwatch = undefined;
    this.session = undefined;
    super.disconnectedCallback();
  }

  /** The document this page may act on: the route's id, once the server served it. Never an id from an action. */
  private heldId(): string | undefined {
    const route = this.route;
    const s = this.session;
    if (!route || !s || this.missing || s.statusOf("doc-status") !== "ready") return undefined;
    return route.id;
  }

  private onReady = (e: Event) => {
    const session = (e as CustomEvent<{ session: ViewSession }>).detail.session;
    this.session = session; // a new view session: nothing held from the old one outlives it
    this.upto = 20;
    this.tabDone = false;
    this.unwatch?.();
    const check = () => {
      if (this.session !== session) return;
      const state = session.statusOf("doc-status");
      if (state === "error") {
        this.missing = true;
        this.served = false;
        this.session = undefined;
        this.unwatch?.();
        this.unwatch = undefined;
        return;
      }
      this.served = state === "ready";
      const status = session.valueOf("doc-status") as { level?: unknown } | undefined;
      this.failed = this.served && status?.level === "critical";
      this.selectContentTab();
    };
    this.unwatch = session.store.runtimeSubscribe(check);
    check();
  };

  /** A deep link to a passage opens the Content tab, once; the server marks the passage it served. */
  private selectContentTab(): void {
    if (this.tabDone || !this.route?.passage) return;
    const tabs = this.renderRoot
      .querySelector("dm-view")
      ?.shadowRoot?.querySelectorAll("[role=tab]");
    const tab = [...(tabs ?? [])].find((b) => b.textContent?.trim() === "Content");
    if (!tab) return;
    this.tabDone = true;
    (tab as HTMLElement).click();
  }

  private run(intent: Intent, extra: { onDeleted?(): void } = {}): Promise<boolean> {
    const session = this.session;
    const services = this.ctx.services;
    const documentId = this.heldId();
    if (!session || !services || documentId === undefined) return Promise.resolve(false);
    const { api, router, toasts } = services;
    return performIntent(intent, {
      api,
      router,
      toasts,
      session,
      documentId,
      upto: () => this.upto,
      confirm: (h, b, l, d) => confirmDialog(h, b, l, d, this.leaving.signal),
      ...extra,
    });
  }

  private act: ActionHandler = async (a) => {
    // What this surface holds is what the server served, read now: never the action's own claim.
    const summary = this.session?.valueOf("doc-summary") as { questions?: unknown } | undefined;
    const questions = Array.isArray(summary?.questions)
      ? (summary.questions as { label?: unknown }[]).map((q) => q?.label)
      : [];
    const intent: Intent | undefined = intentOf("detail", a, { list: questions });
    if (!intent) return { ok: false, reason: "refused" };
    const ok = await this.run(intent);
    if (ok && intent.type === "content.more") this.upto = Math.min(200, this.upto + 20);
    return { ok };
  };

  private ask(): void {
    const id = this.heldId();
    if (id !== undefined) void this.run({ type: "document.ask", id });
  }
  private retry(): void {
    const id = this.heldId();
    if (id !== undefined) void this.run({ type: "document.retry", id });
  }
  private removeDocument(): void {
    const id = this.heldId();
    const router = this.ctx.services?.router;
    if (id === undefined || !router) return;
    void this.run(
      { type: "document.delete", id },
      { onDeleted: () => router.navigate({ name: "documents" }) },
    );
  }

  render() {
    const route = this.route;
    if (!route) return html``;
    const key = `${route.id}|${route.passage ?? ""}`;
    if (key !== this.paramsKey) {
      this.paramsKey = key; // one params object per route, so a re-render never resets the page size
      this.params = { id: route.id, upto: 20, ...(route.passage && { passage: route.passage }) };
    }
    if (key !== this.seenKey) {
      if (this.seenKey !== "") {
        this.missing = false;
        this.served = false;
        this.failed = false;
        this.upto = 20;
        this.tabDone = false;
      }
      this.seenKey = key;
    }
    return html`
      <header>
        <a href="/documents" class="btn ghost" data-back><dm-icon name="caret-left"></dm-icon>Documents</a>
        <span class="grow"></span>
        ${
          this.missing
            ? null
            : html`
          ${this.failed ? html`<button class="btn secondary" data-retry @click=${() => this.retry()}>Retry</button>` : null}
          <button class="btn secondary" data-ask ?disabled=${!this.served} @click=${() => this.ask()}><dm-icon name="chat-circle-text"></dm-icon>Chat about this document</button>
          <button class="btn danger" data-delete ?disabled=${!this.served} @click=${() => this.removeDocument()}>Delete</button>`
        }
      </header>
      ${
        this.missing
          ? html`<div data-not-found><h1>Document not found.</h1><p class="muted">It may have been deleted.</p><a href="/documents">Back to documents</a></div>`
          : html`<dm-view name="detail" .params=${this.params} .onAct=${this.act} @view-ready=${this.onReady}></dm-view>`
      }`;
  }
}
customElements.define("dm-doc-detail", DmDocDetail);
