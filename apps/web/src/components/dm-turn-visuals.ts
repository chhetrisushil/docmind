import { LitElement, css, html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { VISUALS_COPY, type VisualsView } from "../chat/visuals";
import { baseStyles } from "../styles/base";
import "./dm-view";

/** The strip under a cited answer: collapsed by default, expanding in place; its widgets are one `dm-view` over the turn. */
export class DmTurnVisuals extends LitElement {
  static properties = {
    chatId: { type: String },
    ord: { type: Number },
    rev: { type: Number },
    view: { attribute: false },
    open: { state: true },
    seen: { state: true },
    count: { state: true },
  };
  static styles = [
    baseStyles,
    css`
      :host { display: block; margin-top: 8px; }
      [data-toggle] { display: flex; align-items: center; gap: 8px; }
      [data-body][data-collapsed] { max-height: 112px; overflow: hidden; }
      [data-body] { margin-top: 8px; }
      [data-note] { color: var(--dm-muted); margin-left: 8px; }
    `,
  ];
  declare chatId: string;
  declare ord: number;
  declare rev: number;
  declare view: VisualsView | null;
  declare open: boolean;
  declare seen: boolean;
  declare count: number;
  private io: IntersectionObserver | undefined;
  constructor() {
    super();
    this.chatId = "";
    this.ord = 0;
    this.rev = 0;
    this.view = null;
    this.open = false;
    this.seen = false;
    this.count = 0;
  }
  connectedCallback(): void {
    super.connectedCallback();
    if (this.seen) return;
    if (typeof IntersectionObserver === "undefined") {
      this.seen = true; // no way to tell: mount the widgets at once
      return;
    }
    this.io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        this.seen = true;
        this.io?.disconnect();
      }
    });
    this.io.observe(this);
  }
  disconnectedCallback(): void {
    this.io?.disconnect();
    super.disconnectedCallback();
  }
  /** The nested view is this strip's own: its readiness is nobody else's (the chat page would swap its session for it). */
  private ready = (e: Event) => {
    e.stopPropagation();
    const root = (e.target as HTMLElement).shadowRoot;
    this.count = root?.querySelectorAll("[data-widget-kind]").length ?? 0;
  };
  private toggle = () => {
    this.open = !this.open;
  };
  private problem = (e: Event) => e.stopPropagation();
  render() {
    const v = this.view;
    if (!v) return nothing;
    return html`
      ${
        v.strip
          ? html`<button class="btn ghost" data-toggle aria-expanded=${String(this.open)} aria-controls="body" @click=${this.toggle}>
              ${VISUALS_COPY.strip}${this.count > 0 ? html` <span data-count>(${this.count})</span>` : nothing}
            </button>
            <div id="body" data-body ?data-collapsed=${!this.open}>
              ${
                this.seen
                  ? keyed(
                      this.rev,
                      html`<dm-view .turn=${{ chatId: this.chatId, ord: this.ord }} @view-ready=${this.ready} @view-problem=${this.problem}></dm-view>`,
                    )
                  : nothing
              }
            </div>`
          : nothing
      }
      ${
        v.action
          ? html`<button class="btn secondary" data-action ?disabled=${v.busy} @click=${() => this.dispatchEvent(new CustomEvent("visualize", { detail: { ord: this.ord }, bubbles: true, composed: true }))}>${v.action}</button>`
          : nothing
      }
      ${v.note ? html`<span data-note role="status">${v.note}</span>` : nothing}
    `;
  }
}
customElements.define("dm-turn-visuals", DmTurnVisuals);
