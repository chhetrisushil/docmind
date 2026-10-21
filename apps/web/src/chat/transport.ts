import { ChatStreamEvent } from "@docmind/contracts";
import type { Api } from "../api/client";
import { ApiError } from "../api/http";
import type { OpenSse, SseFrame } from "../api/sse";
import { report } from "../report";
import type { AuthStore } from "../state/auth";
import type { ChatFold } from "./feedAdapter";

export interface ChatTransport {
  start(): Promise<void>;
  loadOlder(): Promise<void>;
  /**
   * Sends a question (or, with `editOf`, an edit of the user message with that ordinal). Rejects with the API's error.
   * `key` defaults to a fresh `newMessageKey()`; a caller retrying a send that timed out or failed on the network
   * passes the SAME key so the retry is idempotent.
   */
  send(text: string, editOf?: number, key?: string): Promise<void>;
  /** Asks the server to stop the reply in flight. */
  stop(): Promise<boolean>;
  close(): void;
}

/** A fresh message key (a version 4 UUID, which fits loom-ui's `^[A-Za-z0-9_-]{16,128}$`) from the platform's random source. */
export function newMessageKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface TransportDeps {
  api: Pick<Api, "listMessages" | "sendMessage" | "stopChat">;
  /** Signs the user out on a 401 from the stream, for the session the stream was opened in. */
  auth: Pick<AuthStore, "epoch" | "expired">;
  chatId: string;
  fold: ChatFold;
  open: OpenSse;
  onChange(): void;
  onProblem(p: "load" | "stream" | "gone"): void;
}

export function createChatTransport(d: TransportDeps): ChatTransport {
  let closed = false;
  let stream: { close(): void } | undefined;
  let loadingOlder = false;

  const failure = (err: unknown): "load" | "gone" =>
    err instanceof ApiError && err.status === 404 ? "gone" : "load";

  const onFrame = (frame: SseFrame) => {
    if (closed) return;
    let data: unknown;
    try {
      data = JSON.parse(frame.data);
    } catch {
      return; // not JSON: not ours
    }
    const parsed = ChatStreamEvent.safeParse({
      ...(typeof data === "object" && data !== null ? data : {}),
      kind: frame.event,
    });
    if (!parsed.success) return;
    d.fold.applyStream(parsed.data);
    if (parsed.data.kind === "closed" || parsed.data.kind === "error") stream?.close();
    d.onChange();
    if (parsed.data.kind === "error")
      d.onProblem(parsed.data.code === "not_found" ? "gone" : "stream");
  };

  return {
    async start() {
      try {
        d.fold.applyHistory(await d.api.listMessages(d.chatId, undefined));
      } catch (err) {
        if (!closed) d.onProblem(failure(err));
        return;
      }
      if (closed) return;
      d.onChange();
      const epoch = d.auth.epoch;
      stream = d.open({
        url: () => `/api/chats/${encodeURIComponent(d.chatId)}/stream`,
        lastEventId: () => d.fold.resumeCursor(),
        onOpen: () => {
          if (closed) return;
          d.fold.resetLive();
          d.onChange();
        },
        onFrame,
        onClose: (reason) => {
          if (closed || reason === "closed") return;
          if (reason === "unauthorized") d.auth.expired(epoch);
          else if (reason === "not_found") d.onProblem("gone");
          else d.onProblem("stream"); // "rejected", or "failed": it kept opening and never made progress
        },
      });
    },
    async loadOlder() {
      const cursor = d.fold.olderCursor;
      if (closed || loadingOlder || cursor === null) return;
      loadingOlder = true;
      try {
        d.fold.applyHistory(await d.api.listMessages(d.chatId, cursor));
        if (!closed) d.onChange();
      } catch (err) {
        report("chat-older", err);
        if (!closed) d.onProblem("load");
      } finally {
        loadingOlder = false;
      }
    },
    async send(text, editOf, key = newMessageKey()) {
      await d.api.sendMessage(d.chatId, {
        text,
        messageId: key,
        ...(editOf !== undefined && { editOf }),
      });
    },
    async stop() {
      return (await d.api.stopChat(d.chatId)).stopped;
    },
    close() {
      closed = true;
      stream?.close();
    },
  };
}
