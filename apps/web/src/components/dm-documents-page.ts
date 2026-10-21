import { type DocumentProgressEvent, type Intent, intentOf } from "@docmind/contracts";
import { LitElement, css, html } from "lit";
import { ServicesController } from "../state/services-controller";
import { baseStyles } from "../styles/base";
import { performIntent } from "../surface/perform";
import type { ActionHandler, ViewSession } from "../ui/session";
import { confirmDialog } from "./confirm";
import "./dm-upload-zone";
import "./dm-view";

const HANDLES = ["documents", "doc-total", "doc-ready", "ingest"] as const;
const STREAM_ENDED = "Live updates stopped. Reload the page to see new progress.";

/** The library: a header with the upload zone over the `library` experience (or `library-empty`). It draws no data; it performs intents. */
export class DmDocumentsPage extends LitElement {
  static properties = { empty: { state: true } };
  static styles = [
    baseStyles,
    css`
      :host { display: block; padding: 24px; max-width: 1100px; margin: 0 auto; }
      header { display: grid; gap: 12px; margin-bottom: 16px; }
      h1 { font-size: 24px; }
      dm-upload-zone[variant="empty"] { margin-bottom: 16px; }
    `,
  ];
  declare empty: boolean;
  /** Test seam: how a refresh is delayed. */
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms);
  private readonly ctx = new ServicesController(this, (s) => [s.uploads]);
  private session: ViewSession | undefined;
  private unwatch: (() => void) | undefined;
  private unsettled: (() => void) | undefined;
  private started = false;
  private pending = false;
  /** Bumped when the page leaves, so a refresh scheduled before that does nothing. */
  private epoch = 0;
  /** Aborted when the page leaves: a confirmation still open then answers no. */
  private leaving = new AbortController();
  constructor() {
    super();
    this.empty = false;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.start();
  }
  updated(): void {
    this.start(); // the services arrive through the context after the first connect
  }
  private start(): void {
    const services = this.ctx.services;
    if (this.started || !services || !this.isConnected) return;
    this.started = true;
    if (this.leaving.signal.aborted) this.leaving = new AbortController();
    const epoch = this.epoch;
    services.uploads.startEvents(
      (e) => this.onProgress(e),
      (reason) => {
        if (reason !== "unauthorized") services.toasts.push({ kind: "err", text: STREAM_ENDED }); // the sign-in redirect says the rest
      },
    );
    this.unsettled = services.uploads.onSettled((results) => {
      if (epoch === this.epoch && results.some((r) => r.document)) this.refresh();
    });
  }
  disconnectedCallback(): void {
    this.epoch++;
    this.leaving.abort();
    this.pending = false;
    this.started = false;
    this.ctx.services?.uploads.stopEvents();
    this.unsettled?.();
    this.unsettled = undefined;
    this.unwatch?.();
    this.unwatch = undefined;
    this.session = undefined;
    super.disconnectedCallback();
  }

  /** At most one refresh per 400 ms; a reconnect refreshes at once. */
  private onProgress(e: DocumentProgressEvent | "resync"): void {
    if (e === "resync") {
      this.refresh();
      return;
    }
    if (this.pending) return;
    this.pending = true;
    const epoch = this.epoch;
    this.schedule(() => {
      if (epoch !== this.epoch) return;
      this.pending = false;
      this.refresh();
    }, 400);
  }
  private refresh(): void {
    if (this.empty) {
      this.session = undefined; // the view is swapped: the old session is disposed
      this.unwatch?.();
      this.unwatch = undefined;
      this.empty = false; // a document arrived while the empty state was showing: back to the library
      return;
    }
    for (const h of HANDLES) this.session?.invalidate(h);
  }

  private onReady = (e: Event) => {
    const session = (e as CustomEvent<{ session: ViewSession }>).detail.session;
    this.session = session; // a new view session: nothing held from the old one outlives it
    this.unwatch?.();
    this.unwatch = undefined;
    if ((e.target as HTMLElement).getAttribute("name") !== "library") return;
    const check = () => {
      const total = session.valueOf("doc-total") as { value?: number } | undefined;
      if (session.statusOf("doc-total") === "ready" && total?.value === 0) this.empty = true;
    };
    this.unwatch = session.store.runtimeSubscribe(check);
    check();
  };

  private act: ActionHandler = async (a) => {
    const session = this.session;
    const services = this.ctx.services;
    if (!session || !services) {
      this.ctx.services?.toasts.push({
        kind: "err",
        text: "This view is not ready yet. Try again.",
      });
      return { ok: false };
    }
    // What this surface holds is what the server served in the table's value, read now: never the action's own claim.
    const keys = (session.valueOf("documents") as { rowKeys?: unknown } | undefined)?.rowKeys;
    const held = Array.isArray(keys)
      ? { rowKeys: keys.filter((k): k is string => typeof k === "string") }
      : {};
    const intent: Intent | undefined = intentOf(session.name, a, held);
    if (!intent) return { ok: false, reason: "refused" };
    const { api, router, toasts } = services;
    return {
      ok: await performIntent(intent, {
        api,
        router,
        toasts,
        session,
        confirm: (h, b, l, d) => confirmDialog(h, b, l, d, this.leaving.signal),
      }),
    };
  };

  render() {
    return html`
      <header>
        <h1>Documents</h1>
        <dm-upload-zone variant="compact" ?hide-queue=${this.empty}></dm-upload-zone>
      </header>
      ${this.empty ? html`<dm-upload-zone variant="empty"></dm-upload-zone>` : null}
      <dm-view name=${this.empty ? "library-empty" : "library"} .onAct=${this.act} @view-ready=${this.onReady}></dm-view>`;
  }
}
customElements.define("dm-documents-page", DmDocumentsPage);
