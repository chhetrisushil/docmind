import { LitElement, css, html } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { ICONS } from "./icons";

/** An inline Phosphor icon (build-time constants, never user input). Decorative unless it has a `label`. */
export class DmIcon extends LitElement {
  static properties = { name: { type: String }, label: { type: String } };
  static styles = css`
    :host { display: inline-flex; width: 1em; height: 1em; flex: none; color: inherit; }
    svg { width: 100%; height: 100%; fill: currentColor; }
  `;
  declare name: string;
  declare label: string | undefined;
  render() {
    const svg = (ICONS as Record<string, string>)[this.name];
    return svg ? html`${unsafeSVG(svg)}` : html``;
  }
  updated() {
    if (this.label) {
      this.setAttribute("role", "img");
      this.setAttribute("aria-label", this.label);
      this.removeAttribute("aria-hidden");
    } else {
      this.removeAttribute("role");
      this.removeAttribute("aria-label");
      this.setAttribute("aria-hidden", "true");
    }
  }
}
customElements.define("dm-icon", DmIcon);
