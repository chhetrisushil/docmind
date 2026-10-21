import type { ChatOutcome, ChatToolStep, Citation, Intent } from "@docmind/contracts";
import type { ChatEntry, ChatReasoning, ChatValue } from "@loom-ui/core/chat-ui";
import type { Api } from "../api/client";
import { ApiError } from "../api/http";
import type { OpenSse } from "../api/sse";
import { ChatFold } from "../chat/feedAdapter";
import { toTranscript } from "../chat/transcript";
import { type ChatTransport, createChatTransport, newMessageKey } from "../chat/transport";
import type { AuthStore } from "./auth";
import { Store } from "./store";

export interface EntryView {
  id: string;
  turn: number;
  role: "user" | "assistant";
  status: ChatEntry["status"];
  text: string;
  reason?: string;
  errorId?: string;
  ord?: number;
  citations: Citation[];
  steps: ChatToolStep[];
  reasoning?: ChatReasoning;
  outcome: ChatOutcome | null;
}

export type ChatProblem = "load" | "stream" | "gone" | "unavailable";

export interface ChatViewState {
  entries: EntryView[];
  /** What the `Chat` widget draws: the feed's value with DocMind's tools, reasoning and reference ids laid on. */
  transcript: ChatValue;
  running: boolean;
  pending: boolean;
  liveSteps: ChatToolStep[];
  hasOlder: boolean;
  loadingOlder: boolean;
  /** The last older-page load failed; `loadOlder()` retries. The chat itself still works. */
  olderFailed: boolean;
  loading: boolean;
  closed: boolean;
  problem?: ChatProblem;
  focus?: { entryId: string; passageId?: string };
  sourcesOpen: boolean;
}

/** `busy`: a double activation (silent). `limited`: the server said 429 (show `LIMITED_TEXT`). */
export type SendOutcome = "sent" | "unavailable" | "busy" | "limited" | "failed";

export const LIMITED_TEXT = "You are sending messages too quickly. Wait a moment and try again.";

/** Fixed sentences for the transport's fixed problem tokens. Nothing from the server or the transcript is ever shown. */
export function problemText(p: ChatProblem): string {
  switch (p) {
    case "load":
      return "Could not load this chat. Check your connection and try again.";
    case "stream":
      return "The connection to this chat was lost.";
    case "gone":
      return "This chat no longer exists.";
    case "unavailable":
      return "Chat is not available right now.";
  }
}

/** The reply whose sources are shown, and the passage selected in it. */
export function sourcesOf(state: ChatViewState): {
  entry: EntryView | undefined;
  passageId: string | undefined;
} {
  const chosen = state.focus && state.entries.find((e) => e.id === state.focus?.entryId);
  const entry =
    chosen ??
    [...state.entries].reverse().find((e) => e.role === "assistant" && e.citations.length > 0);
  return { entry, passageId: chosen ? state.focus?.passageId : undefined };
}

/** A failure after which the same message may have reached the server: the retry of the intent reuses its key. */
const mayHaveLanded = (err: unknown): boolean =>
  err instanceof ApiError && (err.status === 0 || err.status === 408 || err.status === 504);

export class ChatController {
  readonly state = new Store<ChatViewState>({
    entries: [],
    transcript: { entries: [] },
    running: false,
    pending: false,
    liveSteps: [],
    hasOlder: false,
    loadingOlder: false,
    olderFailed: false,
    loading: true,
    closed: false,
    sourcesOpen: true,
  });
  private readonly fold = new ChatFold();
  private readonly transport: ChatTransport;
  private awaiting: { turn: number; ord: number } | undefined;
  /** User turns up to this number no longer count as awaiting a reply (the user stopped, or the chat broke). */
  private settledTurn = 0;
  private problem: ChatProblem | undefined;
  private loadingOlder = false;
  private olderFailed = false;
  private wasRunning = false; // for onActivity: a turn just ended
  private stopped = false;
  private sending = false;
  private stopping = false;
  /** Keys of the last few intents, kept until their send succeeds or is refused, so a retry after a timeout is idempotent. */
  private readonly keys = new Map<string, string>(); // signature to key, the last few intents

  constructor(
    private readonly d: {
      api: Pick<Api, "listMessages" | "sendMessage" | "stopChat">;
      auth: Pick<AuthStore, "epoch" | "expired">;
      chatId: string;
      open: OpenSse;
      onActivity?(): void;
    },
  ) {
    this.transport = createChatTransport({
      api: d.api,
      auth: d.auth,
      chatId: d.chatId,
      fold: this.fold,
      open: d.open,
      onChange: () => this.publish(),
      onOlderFailed: () => {
        this.olderFailed = true;
      },
      onProblem: (p) => {
        this.problem = p;
        this.settle();
        this.publish();
      },
    });
  }

  async start(): Promise<void> {
    await this.transport.start();
    this.publish();
  }

  private viewOf(e: ChatEntry): EntryView {
    const extras = this.fold.extrasOf(e.id);
    const history = extras?.reasoning;
    const reasoning: ChatReasoning | undefined =
      e.reasoning ??
      (history
        ? {
            text: history.kind === "redacted" ? "" : history.text,
            kind: history.kind,
            streaming: false,
            ...(history.status && { status: history.status }),
            ...(history.truncated && { truncated: true }),
          }
        : undefined);
    const text = (e.parts ?? []).flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
    return {
      id: e.id,
      turn: e.turn,
      role: e.role as "user" | "assistant",
      status: e.status,
      text,
      ...(e.reason && { reason: e.reason }),
      ...(e.errorId && { errorId: e.errorId }),
      ...(extras && { ord: extras.ord }),
      citations: extras?.citations ?? [],
      steps: e.status === "streaming" ? this.fold.liveSteps : (extras?.steps ?? []),
      ...(reasoning && { reasoning }),
      outcome: extras?.outcome ?? null,
    };
  }

  /** Ends the wait for a reply: the feed's own pending flag does not clear on a stop or a transport problem. */
  private settle(): void {
    const turns = this.state.get().entries.reduce((m, e) => Math.max(m, e.turn), 0);
    this.settledTurn = Math.max(this.settledTurn, turns, (this.awaiting?.turn ?? -1) + 1);
    this.awaiting = undefined;
  }

  private publish(): void {
    if (this.stopped) return;
    const value = this.fold.value();
    const entries = value.entries
      .filter((e) => e.role === "user" || e.role === "assistant")
      .map((e) => this.viewOf(e));
    const closed = value.state === "closed";
    const wait = this.awaiting;
    if (
      wait &&
      (entries.some((e) => e.role === "assistant" && e.turn > wait.turn) ||
        entries.some(
          (e) => e.role === "user" && e.status === "rejected" && (e.ord ?? 0) > wait.ord,
        ) ||
        closed)
    )
      this.awaiting = undefined;
    const lastUser = [...entries]
      .reverse()
      .find((e) => e.role === "user" && e.status !== "rejected");
    const answered =
      lastUser === undefined ||
      lastUser.turn <= this.settledTurn ||
      entries.some((e) => e.role === "assistant" && e.turn >= lastUser.turn);
    // The feed's own `running` is not used: the stream says it once, when it opens, and never again (Finding U12).
    const pending = !closed && (!answered || this.awaiting !== undefined);
    const running = pending || (!closed && entries.some((e) => e.status === "streaming"));
    if (this.wasRunning && !running) this.d.onActivity?.();
    this.wasRunning = running;
    const prev = this.state.get();
    this.state.set({
      entries,
      transcript: toTranscript(value, this.fold),
      running,
      pending,
      liveSteps: this.fold.liveSteps,
      hasOlder: this.fold.olderCursor !== null,
      loadingOlder: this.loadingOlder,
      olderFailed: this.olderFailed,
      loading: !this.fold.historyLoaded && this.problem === undefined,
      closed,
      ...(this.problem && { problem: this.problem }),
      ...(prev.focus && { focus: prev.focus }),
      sourcesOpen: prev.sourcesOpen,
    });
  }

  /** `key` is the widget's own key when the action came from it; otherwise one key per intent is held here. */
  async send(text: string, editOf?: number, key?: string): Promise<SendOutcome> {
    const body = text.trim();
    // Before the first page is in, the awaited turn cannot be told from history: wait for it.
    if (body === "" || this.stopped || !this.fold.historyLoaded) return "failed";
    if (this.sending) return "busy"; // a double activation: the first send is still in flight
    this.sending = true;
    const sig = `${editOf ?? ""}\n${body}`;
    let sendKey = key;
    if (sendKey === undefined) {
      sendKey = this.keys.get(sig) ?? newMessageKey();
      this.keys.delete(sig);
      this.keys.set(sig, sendKey);
      if (this.keys.size > 4) this.keys.delete(this.keys.keys().next().value as string);
    }
    const { entries } = this.state.get();
    this.awaiting = {
      turn: entries.reduce((m, e) => Math.max(m, e.turn), 0),
      ord: entries.reduce((m, e) => Math.max(m, e.ord ?? 0), 0),
    };
    this.publish();
    try {
      await this.transport.send(body, editOf, sendKey);
      if (key === undefined) this.keys.delete(sig);
      if (this.problem === "unavailable") this.problem = undefined;
      this.d.onActivity?.();
      return "sent";
    } catch (err) {
      this.awaiting = undefined;
      if (key === undefined && !mayHaveLanded(err)) this.keys.delete(sig);
      let outcome: SendOutcome = "failed";
      if (err instanceof ApiError && err.status === 503 && err.code === "chat_unavailable") {
        this.problem = "unavailable";
        outcome = "unavailable";
      } else if (err instanceof ApiError && err.status === 429) outcome = "limited";
      this.publish();
      return outcome;
    } finally {
      this.sending = false;
    }
  }

  /** Re-asks the question a reply answered, as an edit of that message (spec §6.4); rejected questions are skipped. */
  async regenerate(entryId: string): Promise<SendOutcome> {
    const { entries } = this.state.get();
    const at = entries.findIndex((e) => e.id === entryId && e.role === "assistant");
    const question =
      at === -1
        ? undefined
        : [...entries.slice(0, at)]
            .reverse()
            .find((e) => e.role === "user" && e.status !== "rejected" && e.ord !== undefined);
    if (!question || question.ord === undefined) return "failed";
    return this.send(question.text, question.ord);
  }

  async stop(): Promise<void> {
    if (this.stopping || this.stopped) return;
    this.stopping = true;
    try {
      await this.transport.stop();
    } catch {
      // nothing to stop, or the server is unreachable: either way stop waiting
    } finally {
      this.stopping = false;
    }
    this.settle();
    this.publish();
  }

  async loadOlder(): Promise<void> {
    if (this.loadingOlder || this.stopped) return;
    this.loadingOlder = true;
    this.olderFailed = false;
    this.publish();
    try {
      await this.transport.loadOlder();
    } finally {
      this.loadingOlder = false;
      this.publish();
    }
  }

  select(entryId: string, passageId?: string): void {
    const cur = this.state.get();
    if (cur.focus?.entryId === entryId && cur.focus.passageId === passageId && cur.sourcesOpen)
      return;
    this.state.set({
      ...cur,
      focus: { entryId, ...(passageId && { passageId }) },
      sourcesOpen: true,
    });
  }

  toggleSources(open?: boolean): void {
    const cur = this.state.get();
    this.state.set({ ...cur, sourcesOpen: open ?? !cur.sourcesOpen });
  }

  /** The reference ids of each reply as served (the transcript's own), for `intentOf("chat", action, { refs })`. */
  heldRefs(): Map<string, string[]> {
    const held = new Map<string, string[]>();
    for (const e of this.state.get().transcript.entries)
      if (e.refs && e.refs.length > 0)
        held.set(
          e.id,
          e.refs.map((r) => r.id),
        );
    return held;
  }

  /** Performs an intent the Chat widget raised (already checked for staleness and resolved by `intentOf`). */
  async perform(intent: Intent): Promise<void> {
    switch (intent.type) {
      case "chat.send":
        await this.send(intent.text, undefined, intent.key);
        return;
      case "chat.cite":
        this.select(intent.entryId, intent.refId);
        return;
      case "chat.older":
        await this.loadOlder();
        return;
      default:
        return; // not a chat intent: the page handles it
    }
  }

  close(): void {
    this.stopped = true;
    this.transport.close();
  }
}
