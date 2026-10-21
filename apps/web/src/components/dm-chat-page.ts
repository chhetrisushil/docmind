import { type ChatScope, intentOf } from "@docmind/contracts";
import { LitElement, css, html } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ChatController, type ChatProblem, LIMITED_TEXT, type SendOutcome } from "../state/chat";
import { ServicesController } from "../state/services-controller";
import { baseStyles } from "../styles/base";
import type { ActionHandler, ViewSession } from "../ui/session";
import "./dm-icon";
import "./dm-view";

/** Fixed sentences. Nothing from the transcript, the server or the chat's title is ever shown in a toast. */
const SEND_TEXT: Record<Exclude<SendOutcome, "sent" | "busy">, string> = {
  limited: LIMITED_TEXT,
  unavailable: "Chat is not available right now.",
  failed: "Could not send that message.",
};

const PROBLEM_TEXT: Record<ChatProblem, string> = {
  load: "Could not load this chat.",
  gone: "This chat does not exist.",
  unavailable: "Chat is not available right now.",
  stream: "Reconnecting...",
};

export class DmChatPage extends LitElement {
  static properties = { tick: { state: true } };
  static styles = [
    baseStyles,
    css`
      :host { display: grid; grid-template-rows: auto auto 1fr; height: 100%; min-height: 0; padding: 16px 24px; max-width: 900px; margin: 0 auto; }
      header { display: flex; align-items: center; gap: 8px; padding-bottom: 8px; }
      header .grow { flex: 1; }
      h1 { font-size: 18px; }
      [data-problem] { display: flex; align-items: center; gap: 8px; padding: 8px 0; color: var(--dm-muted); }
      dm-view { min-height: 0; height: 100%; }
    `,
  ];
  declare tick: number;
  controller: ChatController | undefined;
  private session: ViewSession | undefined;
  private bound: string | undefined | null = null;
  private off: (() => void) | undefined;
  private watch: MutationObserver | undefined;
  private startedIds: string[] | undefined;
  /** A first send is creating its chat: a second activation waits for nothing and starts nothing. */
  private creating = false;
  private readonly ctx = new ServicesController(this, (s) => [s.router]);
  constructor() {
    super();
    this.tick = 0;
  }
  private get chatId(): string | undefined {
    const r = this.ctx.services?.router.get();
    return r?.name === "chat" ? r.chatId : undefined;
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated) this.requestUpdate(); // a reconnect binds the chat again
  }
  protected updated(): void {
    const id = this.chatId;
    if (this.ctx.services && this.bound !== id) this.bind(id);
  }
  disconnectedCallback(): void {
    this.release();
    this.bound = null;
    super.disconnectedCallback();
  }
  /** Stops the stream and drops everything held for this chat. */
  private release(): void {
    this.off?.();
    this.off = undefined;
    this.watch?.disconnect();
    this.watch = undefined;
    this.controller?.close();
    this.controller = undefined;
    this.session = undefined;
  }

  private bind(id: string | undefined): void {
    const svc = this.ctx.services;
    if (!svc) return;
    this.release();
    this.bound = id;
    this.startedIds = undefined;
    this.creating = false;
    if (id === undefined) return void this.requestUpdate();
    const controller = new ChatController({
      api: svc.api,
      auth: svc.auth,
      chatId: id,
      open: svc.open,
      onActivity: () => document.dispatchEvent(new CustomEvent("dm-chats-changed")),
    });
    this.controller = controller;
    this.off = controller.state.subscribe(() => this.sync());
    void this.begin(controller, id);
    void svc.api.getChat(id).then(
      (c) => {
        if (this.controller === controller && typeof c.scope === "object")
          this.startedIds = [...c.scope.documentIds];
      },
      () => {},
    );
    this.requestUpdate();
  }

  private async begin(controller: ChatController, id: string): Promise<void> {
    await controller.start();
    await this.flushOutbox(controller, id);
  }

  /** A message left for this chat is sent once, when the chat is ready for it (again after "Try again"). */
  private async flushOutbox(controller: ChatController, id: string): Promise<void> {
    const svc = this.ctx.services;
    if (!svc || this.controller !== controller || !controller.state.get().ready) return;
    const waiting = svc.outbox.get();
    if (waiting?.chatId !== id) return;
    svc.outbox.set(undefined);
    const out = await controller.send(waiting.text);
    if (out !== "sent" && out !== "busy" && this.controller === controller)
      this.toast(SEND_TEXT[out]);
  }

  /** The page folds the transcript itself, so it publishes it into the experience's store. */
  private sync(): void {
    const st = this.controller?.state.get();
    if (this.controller === undefined && this.session)
      this.session.publish("transcript", { entries: [] }, "Chat");
    else if (st)
      this.session?.publish("transcript", st.transcript, "Chat", { streaming: st.running });
    this.guardComposer();
    this.requestUpdate();
  }
  private onReady = (e: Event) => {
    this.session = (e as CustomEvent<{ session: ViewSession }>).detail.session;
    this.watch?.disconnect();
    const root = (e.target as HTMLElement).shadowRoot;
    if (root) {
      this.watch = new MutationObserver(() => this.guardComposer());
      this.watch.observe(root, { childList: true, subtree: true });
    }
    this.sync();
  };

  /** The composer takes no message until the history is in: an early send would be refused and show a false error. */
  private get ready(): boolean {
    return this.controller === undefined ? true : (this.controller.state.get().ready ?? false);
  }
  private guardComposer(): void {
    const view = this.renderRoot.querySelector("dm-view");
    const field = view?.shadowRoot?.querySelector("lu-text-input");
    if (!field) return;
    if (this.ready) field.removeAttribute("inert");
    else if (!field.hasAttribute("inert")) field.setAttribute("inert", "");
  }

  private toast(text: string): void {
    this.ctx.services?.toasts.push({ kind: "err", text });
  }

  private async send(text: string) {
    const svc = this.ctx.services;
    if (!svc) return { ok: false };
    if (this.controller === undefined) {
      if (this.creating) return { ok: false };
      this.creating = true;
      try {
        const chat = await svc.api.createChat({ scope: "all" });
        if (!this.isConnected || this.chatId !== undefined) return { ok: false };
        svc.outbox.set({ chatId: chat.id, text });
        svc.router.navigate({ name: "chat", chatId: chat.id }, { replace: true });
        return { ok: true };
      } catch {
        this.toast("Could not start a chat.");
        return { ok: false };
      } finally {
        this.creating = false;
      }
    }
    return { ok: false };
  }

  private async scope(value: "all" | "started") {
    const svc = this.ctx.services;
    const id = this.chatId;
    if (!svc || id === undefined) return { ok: false };
    let scope: ChatScope = "all";
    if (value === "started") {
      if (!this.startedIds) {
        this.toast("This chat was not started from specific documents.");
        return { ok: false };
      }
      scope = { documentIds: this.startedIds };
    }
    try {
      await svc.api.patchChat(id, { scope });
      return { ok: true };
    } catch {
      this.toast("Could not change where this chat searches.");
      return { ok: false };
    }
  }

  private act: ActionHandler = async (a) => {
    // The view session has checked the action is fresh. What it names is looked up in what the chat served, never believed.
    const intent = intentOf("chat", a, { refs: this.controller?.heldRefs() ?? new Map() });
    if (!intent) return { ok: false, reason: "refused" };
    switch (intent.type) {
      case "chat.send": {
        if (!this.ready) return { ok: false }; // the composer is disabled; a late submit is dropped, silently
        if (this.controller === undefined) return this.send(intent.text);
        const out = await this.controller.perform(intent);
        if (out === "sent") return { ok: true };
        if (out !== undefined && out !== "busy") this.toast(SEND_TEXT[out]);
        return { ok: false };
      }
      case "chat.scope":
        return this.scope(intent.scope);
      case "chat.cite":
      case "chat.older":
        await this.controller?.perform(intent);
        return { ok: true };
      default:
        return { ok: false, reason: "refused" };
    }
  };

  private async regenerate(entryId: string): Promise<void> {
    const out = await this.controller?.regenerate(entryId);
    if (out !== undefined && out !== "sent" && out !== "busy") this.toast(SEND_TEXT[out]);
  }
  private tryAgain(): void {
    const controller = this.controller;
    const id = this.chatId;
    if (controller && id) void this.begin(controller, id);
  }

  render() {
    const st = this.controller?.state.get();
    const last = st?.entries.at(-1);
    const canRegenerate =
      st?.ready && !st.running && last?.role === "assistant" && last.status !== "streaming";
    return html`
      <header>
        <h1>${this.chatId ? "Chat" : "New chat"}</h1>
        <span class="grow"></span>
        ${st?.running ? html`<button class="btn secondary" data-stop @click=${() => void this.controller?.stop()}><dm-icon name="stop"></dm-icon>Stop</button>` : null}
        ${canRegenerate && last ? html`<button class="btn secondary" data-regenerate @click=${() => void this.regenerate(last.id)}><dm-icon name="arrow-clockwise"></dm-icon>Regenerate</button>` : null}
      </header>
      <div>
        ${
          st?.problem
            ? html`<div data-problem role=${st.problem === "stream" ? "status" : "alert"}>${PROBLEM_TEXT[st.problem]}${st.problem === "load" ? html`<button class="btn ghost" data-try-again @click=${() => this.tryAgain()}>Try again</button>` : st.problem === "gone" ? html`<a href="/chats">Start a new chat</a>` : null}</div>`
            : null
        }
        ${st?.olderFailed ? html`<div data-older-failed role="alert" class="muted">Could not load earlier messages.<button class="btn ghost" data-older-retry @click=${() => void this.controller?.loadOlder()}>Try again</button></div>` : null}
      </div>
      ${keyed(this.chatId ?? "new", html`<dm-view name="chat" .onAct=${this.act} @view-ready=${this.onReady}></dm-view>`)}`;
  }
}
customElements.define("dm-chat-page", DmChatPage);
