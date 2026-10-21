import { type ChatScope, intentOf, sourcesValue } from "@docmind/contracts";
import { LitElement, css, html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { keyed } from "lit/directives/keyed.js";
import {
  ChatController,
  type ChatProblem,
  type ChatViewState,
  LIMITED_TEXT,
  type SendOutcome,
  sourcesOf,
} from "../state/chat";
import { ServicesController } from "../state/services-controller";
import { baseStyles } from "../styles/base";
import { performIntent } from "../surface/perform";
import type { ActionHandler, ViewSession } from "../ui/session";
import { confirmDialog } from "./confirm";
import { DIALOG_CLOSED, deepActiveElement, dialogOpen, flatParent } from "./dm-dialog";
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
  static properties = { chatTitle: { state: true }, queued: { state: true } };
  static styles = [
    baseStyles,
    css`
      :host { display: grid; grid-template-rows: auto auto 1fr; height: 100%; min-height: 0; padding: 16px 24px; max-width: 900px; margin: 0 auto; }
      header { display: flex; align-items: center; gap: 8px; padding-bottom: 8px; }
      header .grow { flex: 1; }
      h1 { font-size: 18px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      [data-problem] { display: flex; align-items: center; gap: 8px; padding: 8px 0; color: var(--dm-muted); }
      dm-view { min-height: 0; height: 100%; }
      .layout { display: grid; grid-template-columns: 1fr; min-height: 0; }
      .layout > .main { min-height: 0; }
      aside h2 { font-size: 15px; margin: 0; }
      aside header { padding: 0 0 8px; }
      @media (min-width: 1100px) {
        :host { max-width: 1280px; }
        .layout { grid-template-columns: 1fr 340px; gap: 16px; }
      }
      aside { overflow: auto; max-height: 100%; }
      [data-backdrop] { position: fixed; inset: 0; background: rgb(0 0 0 / 0.4); z-index: 3; }
      @media (max-width: 1099px) {
        aside { position: fixed; inset: 0 0 0 auto; width: min(380px, 100%); background: var(--dm-surface); box-shadow: var(--dm-shadow-lg); z-index: 4; padding: 12px; overflow: auto; }
      }
    `,
  ];
  /** The served title; undefined until the chat has one (plain text only: never logged, toasted or put in a URL). */
  declare chatTitle: string | undefined;
  /** The first message is waiting after a failed send: Retry or Discard. */
  declare queued: boolean;
  controller: ChatController | undefined;
  private session: ViewSession | undefined;
  private panel: ViewSession | undefined;
  /** The control that opened the panel from a citation: Escape or Close gives focus back to it. */
  private opener: HTMLElement | undefined;
  /** Elements made inert behind the modal (overlay) panel, restored on close. */
  private inerted: HTMLElement[] = [];
  private bound: string | undefined | null = null;
  private off: (() => void) | undefined;
  private watch: MutationObserver | undefined;
  private startedIds: string[] | undefined;
  /** A first send is creating its chat: a second activation waits for nothing and starts nothing. */
  private creating = false;
  private readonly ctx = new ServicesController(this, (s) => [s.router]);
  private flushing = false;
  constructor() {
    super();
    this.chatTitle = undefined;
    this.queued = false;
  }
  private get chatId(): string | undefined {
    const r = this.ctx.services?.router.get();
    return r?.name === "chat" ? r.chatId : undefined;
  }

  /** Below 1100px the panel is an overlay (modal); at or above it, it is docked beside the chat. */
  private get narrow(): boolean {
    return typeof matchMedia === "function" && !matchMedia("(min-width: 1100px)").matches;
  }
  private get modal(): boolean {
    return this.narrow && (this.controller?.state.get().sourcesOpen ?? false);
  }
  private onDocKey = (e: KeyboardEvent) => {
    // An open dialog answers Escape itself; its listener may run after this one, so it is checked, not assumed.
    if (e.key === "Escape" && this.modal && !e.defaultPrevented && !dialogOpen())
      void this.closePanel();
  };
  private wide: MediaQueryList | undefined;
  /** The viewport crossed 1100px: re-evaluate. Narrowing closes the panel (an overlay is never open by itself). */
  private onResize = () => {
    if (this.narrow && this.controller?.state.get().sourcesOpen)
      this.controller.toggleSources(false);
    this.requestUpdate();
  };
  private onDialogClosed = () => {
    if (!this.modal) this.releaseModal();
  };

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("keydown", this.onDocKey);
    document.addEventListener(DIALOG_CLOSED, this.onDialogClosed);
    if (typeof matchMedia === "function") {
      this.wide = matchMedia("(min-width: 1100px)");
      this.wide.addEventListener("change", this.onResize);
    }
    if (this.hasUpdated) this.requestUpdate(); // a reconnect binds the chat again
  }
  protected updated(): void {
    if (this.modal) this.isolate();
    else this.releaseModal();
    const id = this.chatId;
    if (this.ctx.services && this.bound !== id) this.bind(id);
  }
  disconnectedCallback(): void {
    document.removeEventListener("keydown", this.onDocKey);
    document.removeEventListener(DIALOG_CLOSED, this.onDialogClosed);
    this.wide?.removeEventListener("change", this.onResize);
    this.wide = undefined;
    this.releaseModal();
    // A message nobody consumed does not wait for a later visit.
    const svc = this.ctx.services;
    if (svc && svc.outbox.get()?.chatId !== this.chatId) svc.outbox.set(undefined);
    this.release();
    this.bound = null;
    super.disconnectedCallback();
  }
  /** Everything outside the overlay panel stops taking focus and clicks, up through the shadow roots to the document. */
  private isolate(): void {
    const aside = this.renderRoot.querySelector("aside");
    if (!aside) return;
    let node: Node = aside;
    while (node && node !== document.documentElement) {
      const parent = flatParent(node);
      if (!parent || parent === document) break;
      const siblings: Node[] =
        parent instanceof HTMLSlotElement
          ? parent.assignedNodes({ flatten: true })
          : Array.from(parent.childNodes);
      for (const sib of siblings) {
        if (sib === node || !(sib instanceof HTMLElement) || sib.inert) continue;
        if (sib.localName === "script" || sib.localName === "style") continue;
        if (sib.hasAttribute("data-dialog-live") || sib.hasAttribute("data-backdrop")) continue;
        sib.inert = true;
        this.inerted.push(sib);
      }
      node = parent instanceof ShadowRoot ? parent.host : parent;
    }
  }
  /** Nodes the panel made inert stay so while a dialog is open (the dialog skipped them); they are released when it closes. */
  private releaseModal(): void {
    if (dialogOpen()) return;
    for (const el of this.inerted) el.inert = false;
    this.inerted = [];
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
    this.panel = undefined;
    this.opener = undefined;
  }

  private bind(id: string | undefined): void {
    const svc = this.ctx.services;
    if (!svc) return;
    this.release();
    this.bound = id;
    this.startedIds = undefined;
    this.chatTitle = undefined;
    this.queued = false;
    this.creating = false;
    if (svc.outbox.get()?.chatId !== id) svc.outbox.set(undefined); // never sent into a chat other than its own
    if (id === undefined) return void this.requestUpdate();
    const controller = new ChatController({
      api: svc.api,
      auth: svc.auth,
      chatId: id,
      open: svc.open,
      onActivity: () => {
        document.dispatchEvent(new CustomEvent("dm-chats-changed"));
        if (this.controller === controller) this.readMeta(controller, id); // the server may have titled the chat
      },
    });
    this.controller = controller;
    if (this.narrow) controller.toggleSources(false); // an overlay opens on a citation or the toggle, never by itself
    this.off = controller.state.subscribe(() => this.sync());
    void this.begin(controller, id);
    this.readMeta(controller, id);
    this.requestUpdate();
  }

  /** The chat's title and the documents it started with, as served. */
  private readMeta(controller: ChatController, id: string): void {
    void this.ctx.services?.api.getChat(id).then(
      (c) => {
        if (this.controller !== controller) return;
        this.chatTitle = c.title ?? undefined;
        if (typeof c.scope === "object") this.startedIds = [...c.scope.documentIds];
      },
      () => {},
    );
  }

  private async begin(controller: ChatController, id: string): Promise<void> {
    await controller.start();
    await this.flushOutbox(controller, id);
  }

  /** A message left for this chat is sent once, when the chat is ready for it. It stays queued until the send succeeds. */
  private async flushOutbox(controller: ChatController, id: string): Promise<void> {
    const svc = this.ctx.services;
    if (!svc || this.flushing || this.controller !== controller || !controller.state.get().ready)
      return;
    const waiting = svc.outbox.get();
    if (waiting?.chatId !== id) return;
    this.flushing = true;
    try {
      const out = await controller.send(waiting.text);
      if (this.controller !== controller) return;
      if (out === "sent") {
        if (svc.outbox.get() === waiting) svc.outbox.set(undefined);
        this.queued = false;
      } else if (out !== "busy") {
        this.queued = true;
        this.toast(SEND_TEXT[out]);
      }
    } finally {
      this.flushing = false;
    }
  }
  private retryQueued(): void {
    const controller = this.controller;
    const id = this.chatId;
    if (controller && id) void this.flushOutbox(controller, id);
  }
  private discardQueued(): void {
    this.ctx.services?.outbox.set(undefined);
    this.queued = false;
  }

  /** The page folds the transcript itself, so it publishes it into the experience's store. */
  private sync(): void {
    const st = this.controller?.state.get();
    if (this.controller === undefined && this.session)
      this.session.publish("transcript", { entries: [] }, "Chat");
    else if (st)
      this.session?.publish("transcript", st.transcript, "Chat", { streaming: st.running });
    this.syncPanel(st);
    this.guardComposer();
    this.requestUpdate();
  }

  /** The sources of the selected (else newest cited) reply only, from what was served. A reply still streaming has none yet. */
  private sourcesNow(st: ChatViewState) {
    const { entry, passageId } = sourcesOf(st);
    const waiting = st.running && st.focus === undefined;
    return { waiting, value: sourcesValue(waiting ? [] : (entry?.citations ?? []), passageId) };
  }
  private syncPanel(st: ChatViewState | undefined): void {
    if (!st?.sourcesOpen) this.panel = undefined;
    if (!st || !this.panel) return;
    const { waiting, value } = this.sourcesNow(st);
    this.panel.publish("sources", value, "A2UIView", { streaming: waiting });
  }
  private onPanelReady = (e: Event) => {
    this.panel = (e as CustomEvent<{ session: ViewSession }>).detail.session;
    this.syncPanel(this.controller?.state.get());
  };
  private actPanel: ActionHandler = async (a) => {
    const svc = this.ctx.services;
    const st = this.controller?.state.get();
    if (!svc || !st || !this.panel) return { ok: false };
    // What the panel may open is the list as published now, never what the action says.
    const intent = intentOf("sources", a, { list: this.sourcesNow(st).value.sources });
    if (!intent) return { ok: false, reason: "refused" };
    return {
      ok: await performIntent(intent, {
        api: svc.api,
        router: svc.router,
        toasts: svc.toasts,
        session: this.panel,
        confirm: confirmDialog,
      }),
    };
  };
  private async closePanel(): Promise<void> {
    this.controller?.toggleSources(false);
    this.releaseModal();
    await this.updateComplete;
    const back = this.opener?.isConnected
      ? this.opener
      : (this.renderRoot.querySelector("button[data-sources]") as HTMLElement | null);
    this.opener = undefined;
    back?.focus();
  }
  private async openPanel(): Promise<void> {
    this.opener =
      (this.renderRoot.querySelector("button[data-sources]") as HTMLElement | null) ?? undefined;
    this.controller?.toggleSources(true);
    await this.updateComplete;
    (this.renderRoot.querySelector("aside h2") as HTMLElement | null)?.focus();
  }
  private onPanelKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      void this.closePanel();
    }
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
        const route = svc.router.get();
        // The user left before the chat existed: the text is discarded, never sent into a chat they are not in.
        if (!this.isConnected || route.name !== "chat" || route.chatId !== undefined)
          return { ok: false };
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
      case "chat.cite": {
        const active = deepActiveElement();
        this.opener =
          active instanceof HTMLElement && active !== document.body ? active : undefined;
        await this.controller?.perform(intent);
        await this.updateComplete;
        (this.renderRoot.querySelector("aside h2") as HTMLElement | null)?.focus();
        return { ok: true };
      }
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
      <header ?inert=${this.modal}>
        <h1 title=${ifDefined(this.chatTitle)}>${this.chatId && this.chatTitle ? this.chatTitle : "New chat"}</h1>
        <span class="grow"></span>
        <button class="btn secondary" data-sources aria-expanded=${String(st?.sourcesOpen ?? true)} aria-controls=${ifDefined(st?.sourcesOpen === false ? undefined : "sources")} @click=${() => void (st?.sourcesOpen === false ? this.openPanel() : this.closePanel())}>Sources</button>
        ${st?.running ? html`<button class="btn secondary" data-stop @click=${() => void this.controller?.stop()}><dm-icon name="stop"></dm-icon>Stop</button>` : null}
        ${canRegenerate && last ? html`<button class="btn secondary" data-regenerate @click=${() => void this.regenerate(last.id)}><dm-icon name="arrow-clockwise"></dm-icon>Regenerate</button>` : null}
      </header>
      <div>
        ${st && !st.ready && !st.problem && !st.closed ? html`<p data-loading role="status" aria-live="polite" class="muted">Loading conversation…</p>` : null}
        ${st?.closed ? html`<p data-closed role="status" class="muted">This chat has ended. <a href="/chats">Start a new chat</a></p>` : null}
        ${this.queued ? html`<div data-queued role="alert">Your first message was not sent.<button class="btn ghost" data-queued-retry @click=${() => this.retryQueued()}>Retry</button><button class="btn ghost" data-queued-discard @click=${() => this.discardQueued()}>Discard</button></div>` : null}
        ${
          st?.problem
            ? html`<div data-problem role=${st.problem === "stream" ? "status" : "alert"}>${PROBLEM_TEXT[st.problem]}${st.problem === "load" ? html`<button class="btn ghost" data-try-again @click=${() => this.tryAgain()}>Try again</button>` : st.problem === "gone" ? html`<a href="/chats">Start a new chat</a>` : null}</div>`
            : null
        }
        ${st?.olderFailed ? html`<div data-older-failed role="alert" class="muted">Could not load earlier messages.<button class="btn ghost" data-older-retry @click=${() => void this.controller?.loadOlder()}>Try again</button></div>` : null}
      </div>
      <div class="layout">
        <div class="main" ?inert=${this.modal}>${keyed(this.chatId ?? "new", html`<dm-view name="chat" .onAct=${this.act} @view-ready=${this.onReady}></dm-view>`)}</div>
        ${
          st?.sourcesOpen
            ? html`${this.narrow ? html`<div data-backdrop @click=${() => void this.closePanel()}></div>` : null}<aside id="sources" aria-label="Sources" aria-modal=${ifDefined(this.narrow ? "true" : undefined)} @keydown=${(e: KeyboardEvent) => this.onPanelKey(e)}>
                <header><h2 tabindex="-1">Sources</h2><span class="grow"></span><button class="btn ghost" data-sources-close @click=${() => void this.closePanel()}>Close</button></header>
                ${keyed(this.chatId ?? "new", html`<dm-view name="sources" .onAct=${this.actPanel} @view-ready=${this.onPanelReady}></dm-view>`)}
              </aside>`
            : null
        }
      </div>`;
  }
}
customElements.define("dm-chat-page", DmChatPage);
