import type { DocumentTag, DocumentTagsResponse, TagSummary } from "@docmind/contracts";
import { LitElement, css, html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { live } from "lit/directives/live.js";
import type { Api } from "../api/client";
import { ApiError } from "../api/http";
import { ServicesController } from "../state/services-controller";
import { baseStyles } from "../styles/base";

/** "Suggesting…" lasts until a `tags` event or this long: a run that ended with no event (a missed frame, a restart) must not freeze the button. */
export const TAG_SUGGEST_TIMEOUT_MS = 60_000;

const NOTES: Record<string, string> = {
  tag_limit: "A document holds at most 20 tags.",
  invalid_request: "A tag name is 1 to 40 characters, with no control characters.",
};

/** One document's Tags row (chips with remove, an input with autocomplete) and Suggested line (accept, dismiss, Suggest tags). */
export class DmDocTags extends LitElement {
  static properties = {
    documentId: { type: String },
    tags: { state: true },
    suggested: { state: true },
    hasSummary: { state: true },
    all: { state: true },
    draft: { state: true },
    suggesting: { state: true },
    failed: { state: true },
    note: { state: true },
    suggestNote: { state: true },
  };
  static styles = [
    baseStyles,
    css`
      :host { display: grid; gap: 8px; margin-bottom: 16px; }
      .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
      .label { color: var(--dm-muted); min-width: 64px; }
      .chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 10px; min-height: 28px; border-radius: 999px; border: 1px solid var(--dm-divider); }
      .chip.suggested { border-style: dashed; }
      .chip button { border: 0; background: transparent; cursor: pointer; color: var(--dm-muted); min-width: 24px; min-height: 24px; border-radius: 999px; }
      .chip button:hover { color: var(--dm-text); background: color-mix(in srgb, var(--dm-text) 8%, transparent); }
      input { min-width: 18ch; }
      [role="alert"] { color: var(--dm-danger, #b3261e); margin: 0; }
    `,
  ];
  declare documentId: string;
  declare tags: DocumentTag[];
  declare suggested: string[];
  declare hasSummary: boolean;
  declare all: TagSummary[] | null;
  declare draft: string;
  declare suggesting: boolean;
  declare failed: boolean;
  declare note: string | null;
  declare suggestNote: string | null;
  /** Test seam: how long "Suggesting…" waits for an event (default TAG_SUGGEST_TIMEOUT_MS). */
  timeoutMs = TAG_SUGGEST_TIMEOUT_MS;
  private readonly ctx = new ServicesController(this);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loadedFor: string | undefined;
  constructor() {
    super();
    this.documentId = "";
    this.tags = [];
    this.suggested = [];
    this.hasSummary = false;
    this.all = null;
    this.draft = "";
    this.suggesting = false;
    this.failed = false;
    this.note = null;
    this.suggestNote = null;
  }

  protected willUpdate(): void {
    if (this.documentId && this.documentId !== this.loadedFor && this.ctx.services) {
      this.loadedFor = this.documentId;
      this.tags = [];
      this.suggested = [];
      this.all = null;
      this.stopWaiting();
      void this.reload();
    }
  }
  disconnectedCallback(): void {
    clearTimeout(this.timer);
    super.disconnectedCallback();
  }

  /** Reads the document's tags and suggestions again. */
  private async reload(): Promise<void> {
    const api = this.ctx.services?.api;
    const id = this.documentId;
    if (!api || !id) return;
    try {
      const doc = await api.getDocument(id);
      if (id !== this.documentId) return;
      this.tags = doc.tags;
      this.suggested = doc.suggestedTags ?? [];
      this.hasSummary = doc.summary !== null;
    } catch {
      // The row keeps what it had; the next event or action reads again.
    }
  }
  private take(r: DocumentTagsResponse): void {
    this.tags = r.tags;
    this.suggested = r.suggestedTags;
    this.note = null;
  }
  private stopWaiting(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.suggesting = false;
  }
  private armWatch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.suggesting = false;
      void this.reload();
    }, this.timeoutMs);
  }

  /** A `tags` progress event of this document (or a resync after a missed frame): the run ended, so read again. */
  async onEvent(kind: "suggested" | "failed" | "resync"): Promise<void> {
    if (kind === "failed") {
      this.stopWaiting();
      this.failed = true;
      return;
    }
    if (kind === "suggested") {
      this.stopWaiting();
      this.failed = false;
    }
    await this.reload();
  }

  private async act(work: (api: Api, id: string) => Promise<DocumentTagsResponse>): Promise<void> {
    const api = this.ctx.services?.api;
    if (!api) return;
    const id = this.documentId;
    try {
      const r = await work(api, id);
      if (id === this.documentId) this.take(r);
    } catch (err) {
      this.note =
        err instanceof ApiError && NOTES[err.code ?? ""]
          ? (NOTES[err.code ?? ""] as string)
          : "Couldn't update the tags. Try again.";
    }
  }
  private add(): void {
    const name = this.draft.trim();
    if (name === "") return;
    this.draft = "";
    void this.act((api, id) => api.addDocumentTag(id, name));
  }
  private async loadAll(): Promise<void> {
    const api = this.ctx.services?.api;
    if (this.all !== null || !api) return;
    this.all = []; // one load, whatever the number of focuses
    try {
      this.all = (await api.listTags()).tags;
    } catch {
      this.all = [];
    }
  }
  private suggest(): void {
    const api = this.ctx.services?.api;
    if (!api || this.suggesting || !this.hasSummary) return;
    this.suggesting = true;
    this.failed = false;
    this.suggestNote = null;
    this.armWatch();
    const id = this.documentId;
    void api.refreshTagSuggestions(id).catch((err: unknown) => {
      if (id !== this.documentId) return;
      if (err instanceof ApiError && err.status === 409 && err.code === "suggest_running") return; // keep waiting for its event
      this.stopWaiting();
      if (err instanceof ApiError && err.status === 429)
        this.suggestNote = "Too many requests. Try again in a minute.";
      else if (err instanceof ApiError && err.status === 409 && err.code === "no_summary")
        this.suggestNote = "This document has no summary yet.";
      else if (err instanceof ApiError && err.status === 409)
        this.suggestNote = "Tag suggestions are not available.";
      else this.failed = true;
    });
  }

  render() {
    const have = new Set(this.tags.map((t) => t.name.toLowerCase()));
    const options = (this.all ?? []).filter((t) => !have.has(t.name.toLowerCase()));
    const reasonId = "suggest-reason";
    return html`
      <div class="row" role="group" aria-label="Tags" data-tags>
        <span class="label">Tags</span>
        ${this.tags.map((t) => html`<span class="chip"><span data-name>${t.name}</span><button type="button" aria-label=${`Remove tag ${t.name}`} @click=${() => void this.act((api, id) => api.removeDocumentTag(id, t.id))}>×</button></span>`)}
        <input aria-label="Add a tag" list="doc-tag-options" autocomplete="off" maxlength="40" .value=${live(this.draft)}
          @focus=${() => void this.loadAll()}
          @input=${(e: Event) => {
            this.draft = (e.target as HTMLInputElement).value;
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter") {
              e.preventDefault();
              this.add();
            }
          }} />
        <datalist id="doc-tag-options">${options.map((t) => html`<option value=${t.name}></option>`)}</datalist>
      </div>
      ${this.note ? html`<p role="alert" data-note>${this.note}</p>` : null}
      <div class="row" role="group" aria-label="Suggested tags" data-suggested-row>
        <span class="label">Suggested</span>
        <span class="row" data-suggested>${this.suggested.map((name) => html`<span class="chip suggested"><span data-name>${name}</span><button type="button" aria-label=${`Accept suggested tag ${name}`} @click=${() => void this.act((api, id) => api.acceptTagSuggestion(id, name))}>✓</button><button type="button" aria-label=${`Dismiss suggested tag ${name}`} @click=${() => void this.act((api, id) => api.dismissTagSuggestion(id, name))}>×</button></span>`)}</span>
        <button type="button" class="btn secondary" data-suggest ?disabled=${this.suggesting || !this.hasSummary} aria-busy=${this.suggesting ? "true" : "false"} aria-describedby=${ifDefined(this.hasSummary ? undefined : reasonId)} @click=${() => this.suggest()}>${this.suggesting ? "Suggesting…" : "Suggest tags"}</button>
        ${this.hasSummary ? null : html`<span class="muted" id=${reasonId} data-reason>Available once the document has a summary.</span>`}
        ${this.suggestNote ? html`<span data-suggest-note role="status">${this.suggestNote}</span>` : null}
      </div>
      ${this.failed ? html`<p class="muted" role="status" data-suggest-failed>Couldn't suggest tags. <button type="button" class="btn secondary" data-suggest-retry @click=${() => this.suggest()}>Retry</button></p>` : null}`;
  }
}
customElements.define("dm-doc-tags", DmDocTags);
