import { LitElement, css, html } from "lit";
import { baseStyles } from "../styles/base";

export class DmNotFound extends LitElement {
  static properties = {};
  static styles = [
    baseStyles,
    css`:host { display: grid; place-items: center; min-height: 100%; padding: 32px 16px; text-align: center; } main { display: grid; gap: 10px; } h1 { font-size: 26px; }`,
  ];
  render() {
    return html`<main><h1>Page not found</h1><p class="muted">There is nothing at this address.</p><p><a href="/chats">Go to your chats</a></p></main>`;
  }
}
customElements.define("dm-not-found", DmNotFound);
