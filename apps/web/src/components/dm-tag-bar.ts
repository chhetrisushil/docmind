import type { TagSummary } from "@docmind/contracts";
import { LitElement, css, html } from "lit";
import { baseStyles } from "../styles/base";

export type TagMatch = "any" | "all";
export interface TagSelectionDetail {
  tags: string[];
  match: TagMatch;
}
/** A filter holds at most 10 tags (the server refuses more). */
export const MAX_SELECTED_TAGS = 10;

/**
 * The library's tag bar: one toggle chip per tag, an Any / All radio group (enabled from 2 selected tags), Clear and Manage
 * tags. It owns no data: the page gives it the tags and the selection, and it reports changes as `tag-selection`.
 */
export class DmTagBar extends LitElement {
  static properties = {
    tags: { attribute: false },
    selected: { attribute: false },
    match: { type: String },
    count: { attribute: false },
    managing: { type: Boolean },
  };
  static styles = [
    baseStyles,
    css`
      :host { display: block; margin-bottom: 12px; }
      .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; min-height: 28px; border-radius: 999px; border: 1px solid var(--dm-divider); background: transparent; color: var(--dm-text); cursor: pointer; }
      .chip[aria-pressed="true"] { border-color: var(--dm-accent); color: var(--dm-accent); background: color-mix(in srgb, var(--dm-accent) 12%, transparent); }
      .chip:disabled { opacity: 0.45; cursor: default; }
      .chip .n { color: var(--dm-muted); font-size: 12px; }
      .mode { display: inline-flex; gap: 10px; align-items: center; }
      .mode label { display: inline-flex; gap: 4px; align-items: center; }
      .mode input:disabled + span { color: var(--dm-muted); }
    `,
  ];
  declare tags: TagSummary[];
  declare selected: string[];
  declare match: TagMatch;
  /** How many documents the filtered table shows; null while unknown. */
  declare count: number | null;
  declare managing: boolean;
  constructor() {
    super();
    this.tags = [];
    this.selected = [];
    this.match = "any";
    this.count = null;
    this.managing = false;
  }

  private emit(tags: string[], match: TagMatch): void {
    this.dispatchEvent(
      new CustomEvent<TagSelectionDetail>("tag-selection", {
        detail: { tags, match },
        bubbles: true,
        composed: true,
      }),
    );
  }
  private toggle(id: string): void {
    this.emit(
      this.selected.includes(id) ? this.selected.filter((x) => x !== id) : [...this.selected, id],
      this.match,
    );
  }
  private announcement(): string {
    if (this.selected.length === 0 || this.count === null) return "";
    return this.count === 1 ? "1 document matches" : `${this.count} documents match`;
  }

  render() {
    const full = this.selected.length >= MAX_SELECTED_TAGS;
    return html`
      <div class="bar" role="group" aria-label="Filter by tag">
        <div class="chips">
          ${this.tags.map((t) => {
            const on = this.selected.includes(t.id);
            return html`<button type="button" class="chip" data-tag=${t.id} aria-pressed=${on ? "true" : "false"} ?disabled=${full && !on} @click=${() => this.toggle(t.id)}>${t.name} <span class="n">${t.documents}</span></button>`;
          })}
        </div>
        <div class="mode" role="radiogroup" aria-label="Match">
          ${(["any", "all"] as const).map(
            (m) =>
              html`<label><input type="radio" name="match" value=${m} .checked=${this.match === m} ?disabled=${this.selected.length < 2} @change=${() => this.emit(this.selected, m)} /><span>${m === "any" ? "Any" : "All"}</span></label>`,
          )}
        </div>
        <button type="button" class="btn ghost" data-clear ?disabled=${this.selected.length === 0} @click=${() => this.emit([], "any")}>Clear</button>
        <button type="button" class="btn ghost" data-manage aria-expanded=${this.managing ? "true" : "false"} @click=${() => this.dispatchEvent(new CustomEvent("manage-toggle", { bubbles: true, composed: true }))}>Manage tags</button>
      </div>
      <p class="sr-only" role="status" aria-live="polite" data-count>${this.announcement()}</p>`;
  }
}
customElements.define("dm-tag-bar", DmTagBar);
