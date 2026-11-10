import { type TagSummary, clipTagName } from "@docmind/contracts";
import { LitElement, css, html } from "lit";
import { live } from "lit/directives/live.js";
import { ApiError } from "../api/http";
import { ServicesController } from "../state/services-controller";
import { baseStyles } from "../styles/base";
import { confirmDialog } from "./confirm";

const used = (n: number): string => `${n} ${n === 1 ? "document" : "documents"}`;

/** The Manage tags panel: rename a tag inline, delete it after a confirmation that names how many documents use it. */
export class DmTagManage extends LitElement {
  static properties = {
    tags: { attribute: false },
    editing: { state: true },
    draft: { state: true },
    error: { state: true },
    busy: { state: true },
  };
  static styles = [
    baseStyles,
    css`
      :host { display: block; margin: 0 0 16px; padding: 12px; border: 1px solid var(--dm-divider); border-radius: var(--dm-radius-md); }
      ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
      li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .name { min-width: 8ch; font-weight: 500; }
      .n { color: var(--dm-muted); }
      input { min-width: 16ch; }
      [role="alert"] { color: var(--dm-danger, #b3261e); margin: 8px 0 0; }
    `,
  ];
  declare tags: TagSummary[];
  declare editing: string | null;
  declare draft: string;
  declare error: string | null;
  declare busy: boolean;
  private readonly ctx = new ServicesController(this);
  private leaving = new AbortController();
  constructor() {
    super();
    this.tags = [];
    this.editing = null;
    this.draft = "";
    this.error = null;
    this.busy = false;
  }
  connectedCallback(): void {
    super.connectedCallback();
    if (this.leaving.signal.aborted) this.leaving = new AbortController();
  }
  disconnectedCallback(): void {
    this.leaving.abort(); // a confirmation still open then answers no
    super.disconnectedCallback();
  }

  private changed(): void {
    this.dispatchEvent(new CustomEvent("tags-changed", { bubbles: true, composed: true }));
  }
  private edit(t: TagSummary): void {
    this.editing = t.id;
    this.draft = t.name;
    this.error = null;
  }
  private async save(t: TagSummary): Promise<void> {
    const api = this.ctx.services?.api;
    const name = this.draft.trim();
    if (!api || this.busy) return;
    if (name === "") {
      this.error = "Enter a name.";
      return;
    }
    if (name === t.name) {
      this.editing = null;
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      await api.renameTag(t.id, name);
      this.editing = null;
      this.changed();
    } catch (err) {
      this.error =
        err instanceof ApiError && err.status === 409
          ? "A tag with that name already exists."
          : err instanceof ApiError && err.status === 400
            ? "That is not a valid tag name (1 to 40 characters, no control characters)."
            : "Couldn't rename the tag. Try again.";
    } finally {
      this.busy = false;
    }
  }
  private async confirmRemove(t: TagSummary): Promise<void> {
    const api = this.ctx.services?.api;
    if (!api) return;
    const body =
      t.documents === 0
        ? `"${t.name}" is used by no document. Deleting it cannot change any document.`
        : `"${t.name}" is used by ${used(t.documents)}. Deleting it removes it from them; the documents are kept.`;
    if (!(await confirmDialog("Delete this tag?", body, "Delete", true, this.leaving.signal)))
      return;
    this.error = null;
    try {
      await api.deleteTag(t.id);
      this.changed();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        this.changed(); // already gone: reload the list
        return;
      }
      this.error = "Couldn't delete the tag. Try again.";
    }
  }
  private onKey(e: KeyboardEvent, t: TagSummary): void {
    if (e.key === "Enter") void this.save(t);
    else if (e.key === "Escape") this.editing = null;
  }

  render() {
    return html`
      <ul>
        ${this.tags.map((t) =>
          this.editing === t.id
            ? html`<li><input aria-label=${`New name for ${t.name}`} .value=${live(this.draft)} @input=${(
                e: Event,
              ) => {
                const input = e.target as HTMLInputElement;
                this.draft = clipTagName(input.value);
                if (input.value !== this.draft) input.value = this.draft;
              }} @keydown=${(e: KeyboardEvent) => this.onKey(e, t)} />
                <button type="button" class="btn primary" data-save ?disabled=${this.busy} @click=${() => void this.save(t)}>Save</button>
                <button type="button" class="btn ghost" data-cancel @click=${() => {
                  this.editing = null;
                }}>Cancel</button></li>`
            : html`<li><span class="name">${t.name}</span> <span class="n">${used(t.documents)}</span>
                <button type="button" class="btn ghost" aria-label=${`Rename ${t.name}`} @click=${() => this.edit(t)}>Rename</button>
                <button type="button" class="btn ghost" aria-label=${`Delete ${t.name}`} @click=${() => void this.confirmRemove(t)}>Delete</button></li>`,
        )}
      </ul>
      ${this.error ? html`<p role="alert">${this.error}</p>` : null}`;
  }
}
customElements.define("dm-tag-manage", DmTagManage);
