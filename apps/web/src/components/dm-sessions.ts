import { type Intent, intentOf } from "@docmind/contracts";
import { LitElement, css, html } from "lit";
import { ServicesController } from "../state/services-controller";
import { baseStyles } from "../styles/base";
import { performIntent } from "../surface/perform";
import type { ActionHandler, ViewSession } from "../ui/session";
import { confirmDialog } from "./confirm";
import { promptDialog } from "./prompt";
import "./dm-view";

type ChatsTable = { rowKeys?: unknown; rows?: unknown };

/** The chat list of the sidebar: the `sessions` experience, and the intents it raises. One view session for as long as it is connected. */
export class DmSessions extends LitElement {
  static styles = [baseStyles, css`:host { display: block; }`];
  /** Test seam: how a refresh is delayed. */
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => void setTimeout(fn, ms);
  private session: ViewSession | undefined;
  private readonly ctx = new ServicesController(this);
  private pending = false;
  /** Bumped on disconnect so a refresh scheduled before it does nothing. */
  private epoch = 0;
  /** Aborted on disconnect: a dialog still open then answers no. */
  private leaving = new AbortController();

  /** `dm-chats-changed` (the chat page: a turn, a title) coalesces: at most one refresh per 250 ms. */
  private onChanged = () => {
    if (this.pending) return;
    this.pending = true;
    const epoch = this.epoch;
    this.schedule(() => {
      if (epoch !== this.epoch) return;
      this.pending = false;
      this.session?.invalidate("chats");
    }, 250);
  };
  connectedCallback(): void {
    super.connectedCallback();
    if (this.leaving.signal.aborted) this.leaving = new AbortController();
    document.addEventListener("dm-chats-changed", this.onChanged);
  }
  disconnectedCallback(): void {
    document.removeEventListener("dm-chats-changed", this.onChanged);
    this.epoch++;
    this.pending = false;
    this.leaving.abort();
    this.session = undefined;
    super.disconnectedCallback();
  }

  private act: ActionHandler = async (a) => {
    const session = this.session;
    const svc = this.ctx.services;
    if (!session || !svc) return { ok: false };
    // What the table holds is what the server served in its value, read now: never the action's own claim.
    const table = session.valueOf("chats") as ChatsTable | undefined;
    const keys = Array.isArray(table?.rowKeys)
      ? (table.rowKeys as unknown[]).filter((k): k is string => typeof k === "string")
      : [];
    const intent: Intent | undefined = intentOf(session.name, a, { rowKeys: keys });
    if (!intent) return { ok: false, reason: "refused" };
    const titleOf = (id: string): string => {
      const i = keys.indexOf(id);
      const row = Array.isArray(table?.rows) ? (table.rows as unknown[])[i] : undefined;
      const title = Array.isArray(row) ? String(row[0] ?? "") : "";
      return title === "New chat" ? "" : title;
    };
    const { api, router, toasts } = svc;
    const signal = this.leaving.signal;
    return {
      ok: await performIntent(intent, {
        api,
        router,
        toasts,
        session,
        confirm: (h, b, l, d) => confirmDialog(h, b, l, d, signal),
        prompt: (h, l, i, c) => promptDialog(h, l, i, c, signal),
        titleOf,
        active: () => this.isConnected && !signal.aborted,
        get openChatId() {
          const route = router.get();
          return route.name === "chat" ? route.chatId : undefined;
        },
      }),
    };
  };

  private onReady = (e: Event) => {
    this.session = (e as CustomEvent<{ session: ViewSession }>).detail.session;
  };
  render() {
    return html`<dm-view name="sessions" .onAct=${this.act} @view-ready=${this.onReady}></dm-view>`;
  }
}
customElements.define("dm-sessions", DmSessions);
