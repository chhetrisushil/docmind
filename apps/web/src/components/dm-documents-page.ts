import {
  type DocumentProgressEvent,
  type Intent,
  type TagSummary,
  intentOf,
} from "@docmind/contracts";
import { TABLE_TOKEN } from "@loom-ui/core/browser";
import { LitElement, css, html } from "lit";
import { ServicesController } from "../state/services-controller";
import { baseStyles } from "../styles/base";
import { performIntent } from "../surface/perform";
import type { ActionAnswer, ActionHandler, ViewSession } from "../ui/session";
import { confirmDialog } from "./confirm";
import "./dm-tag-bar";
import "./dm-tag-manage";
import type { TagSelectionDetail } from "./dm-tag-bar";
import "./dm-upload-zone";
import "./dm-view";

const HANDLES = ["documents", "doc-total", "doc-ready", "ingest"] as const;
/** The Tags column of the library table (see the reshaper). */
const TAGS_COLUMN = 1;
const STREAM_ENDED = "Live updates stopped. Reload the page to see new progress.";

/** The library: one upload zone (compact in the header, or the big one when the library is empty) over the `library` experience (or `library-empty`). It draws no data; it performs intents. */
export class DmDocumentsPage extends LitElement {
  static properties = {
    empty: { state: true },
    tags: { state: true },
    managing: { state: true },
    count: { state: true },
  };
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
  declare tags: TagSummary[];
  declare managing: boolean;
  declare count: number | null;
  /** Test seam: how a refresh is delayed. */
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms);
  private readonly ctx = new ServicesController(this, (s) => [s.uploads, s.router]);
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
    this.tags = [];
    this.managing = false;
    this.count = null;
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
    void this.loadTags();
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
    void this.loadTags(); // the counts on the chips change with uploads and deletes
    if (this.empty) {
      this.session = undefined; // the view is swapped: the old session is disposed
      this.unwatch?.();
      this.unwatch = undefined;
      this.empty = false; // a document arrived while the empty state was showing: back to the library
      return;
    }
    for (const h of HANDLES) this.session?.invalidate(h);
  }

  private paramsKey = "";
  private libraryParams: Record<string, string | number> = { tags: "", match: "any" };

  /** What the address says is selected: ids and the mode. */
  private selection(): { tags: string[]; match: "any" | "all" } {
    const r = this.ctx.services?.router.get();
    return r?.name === "documents"
      ? { tags: r.tags ?? [], match: r.match ?? "any" }
      : { tags: [], match: "any" };
  }
  /** One params object per selection, so a re-render never re-sends the parameters (the view applies it when the object changes). */
  private paramsFor(sel: { tags: string[]; match: string }): Record<string, string | number> {
    const key = `${sel.tags.join(",")}|${sel.match}`;
    if (key !== this.paramsKey) {
      this.paramsKey = key;
      this.libraryParams = { tags: sel.tags.join(","), match: sel.match };
    }
    return this.libraryParams;
  }
  private async loadTags(): Promise<void> {
    const api = this.ctx.services?.api;
    if (!api) return;
    const epoch = this.epoch;
    try {
      const { tags } = await api.listTags();
      if (epoch !== this.epoch) return;
      this.tags = tags;
      this.pruneSelection();
    } catch {
      // The bar keeps what it had; the table still works without it.
    }
  }
  /** A tag the server no longer has leaves the address (replacing the entry, not adding one). */
  private pruneSelection(): void {
    const router = this.ctx.services?.router;
    const sel = this.selection();
    const known = new Set(this.tags.map((t) => t.id));
    const kept = sel.tags.filter((id) => known.has(id));
    if (!router || kept.length === sel.tags.length) return;
    router.navigate(
      {
        name: "documents",
        ...(kept.length > 0 && {
          tags: kept,
          ...(sel.match === "all" && { match: "all" as const }),
        }),
      },
      { replace: true },
    );
  }
  private onSelect = (e: Event) => {
    const { tags, match } = (e as CustomEvent<TagSelectionDetail>).detail;
    this.ctx.services?.router.navigate({
      name: "documents",
      ...(tags.length > 0 && { tags, ...(match === "all" && { match: "all" as const }) }),
    });
  };
  private clear(): void {
    this.ctx.services?.router.navigate({ name: "documents" });
  }
  /**
   * A tag chip in a row (`TABLE_TOKEN`, `payload: { rowKey, tokenId }`): filter the list to that tag alone. The selection is
   * replaced (Any and All reset: one tag has no mode). What the surface holds is what the server served in the table's value,
   * read now, never the action's own claim: the row key must be one of `rowKeys`, and the tag a token of that row's Tags cell.
   */
  private onTagChip(session: ViewSession, payload: Record<string, unknown>): ActionAnswer {
    const table = session.valueOf("documents") as { rowKeys?: unknown; rows?: unknown } | undefined;
    const { rowKey, tokenId } = payload;
    const at = Array.isArray(table?.rowKeys) ? table.rowKeys.indexOf(rowKey) : -1;
    const row = at >= 0 && Array.isArray(table?.rows) ? table.rows[at] : undefined;
    const cell = Array.isArray(row)
      ? (row[TAGS_COLUMN] as { tokens?: unknown } | undefined)
      : undefined;
    const tokens = Array.isArray(cell?.tokens) ? (cell.tokens as { id?: unknown }[]) : [];
    if (typeof tokenId !== "string" || !tokens.some((t) => t?.id === tokenId))
      return { ok: false, reason: "refused" };
    this.ctx.services?.router.navigate({ name: "documents", tags: [tokenId] });
    return { ok: true };
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
      const rows = session.valueOf("documents") as { rowKeys?: unknown } | undefined;
      this.count =
        session.statusOf("documents") === "ready" && Array.isArray(rows?.rowKeys)
          ? rows.rowKeys.length
          : null;
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
    if (a.type === TABLE_TOKEN) return this.onTagChip(session, a.payload); // a chip navigates; it is not an intent (intentOf has no case for it)
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
        active: () => this.isConnected && !this.leaving.signal.aborted,
        confirm: (h, b, l, d) => confirmDialog(h, b, l, d, this.leaving.signal),
      }),
    };
  };

  render() {
    const sel = this.selection();
    const filtering = sel.tags.length > 0;
    const showBar = !this.empty && (this.tags.length > 0 || filtering);
    return html`
      <header>
        <h1>Documents</h1>
        ${this.empty ? null : html`<dm-upload-zone variant="compact"></dm-upload-zone>`}
      </header>
      ${this.empty ? html`<dm-upload-zone variant="empty"></dm-upload-zone>` : null}
      ${
        showBar
          ? html`<dm-tag-bar .tags=${this.tags} .selected=${sel.tags} .match=${sel.match} .count=${this.count} .managing=${this.managing} @tag-selection=${this.onSelect} @manage-toggle=${() => {
              this.managing = !this.managing;
            }}></dm-tag-bar>
            ${this.managing ? html`<dm-tag-manage .tags=${this.tags} @tags-changed=${() => void this.loadTags()}></dm-tag-manage>` : null}`
          : null
      }
      ${
        !this.empty && filtering && this.count === 0
          ? html`<p data-no-match role="status">No documents match these tags. <button class="btn ghost" data-clear-filter @click=${() => this.clear()}>Clear</button></p>`
          : null
      }
      <dm-view name=${this.empty ? "library-empty" : "library"} .params=${this.empty ? undefined : this.paramsFor(sel)} .onAct=${this.act} @view-ready=${this.onReady}></dm-view>`;
  }
}
customElements.define("dm-documents-page", DmDocumentsPage);
