import type { ChatMessageDto } from "@docmind/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import type { SseOptions } from "../api/sse";
import { ChatFold } from "./feedAdapter";
import { createChatTransport, newMessageKey } from "./transport";

const msg = (
  ord: number,
  role: "user" | "assistant",
  turn: number,
  over: Partial<ChatMessageDto> = {},
): ChatMessageDto => ({
  id: String(ord),
  turn,
  role,
  text: `${role} ${ord}`,
  status: "complete",
  citations: [],
  cursor: `1.${ord * 10}`,
  reasoning: null,
  steps: [],
  outcome: null,
  createdAt: "2026-10-21T10:00:00.000Z",
  ...over,
});

function setup(
  listMessages = vi.fn(async () => ({
    items: [msg(1, "user", 1), msg(2, "assistant", 1)],
    nextCursor: "1.5" as string | null,
  })),
) {
  const fold = new ChatFold();
  const sse: { opts?: SseOptions; closed: boolean } = { closed: false };
  const open = vi.fn((opts: SseOptions) => {
    sse.opts = opts;
    return {
      close: () => {
        sse.closed = true;
      },
    };
  });
  const sendMessage = vi.fn(async () => ({ messageId: "x" }));
  const stopChat = vi.fn(async () => ({ stopped: true }));
  const auth = { epoch: 7, expired: vi.fn() };
  const onChange = vi.fn();
  const onProblem = vi.fn();
  const transport = createChatTransport({
    api: { listMessages, sendMessage, stopChat } as never,
    auth,
    chatId: "c1",
    fold,
    open: open as never,
    onChange,
    onProblem,
  });
  const frame = (event: string, data: unknown) =>
    sse.opts?.onFrame({ event, data: JSON.stringify(data), id: undefined });
  return {
    fold,
    sse,
    open,
    onChange,
    onProblem,
    transport,
    listMessages,
    frame,
    sendMessage,
    stopChat,
    auth,
  };
}

describe("createChatTransport", () => {
  it("loads the newest page, then opens the stream resuming after the newest durable cursor", async () => {
    const t = setup();
    await t.transport.start();
    expect(t.listMessages).toHaveBeenCalledWith("c1", undefined);
    expect(t.fold.value().entries.map((e) => e.id)).toEqual(["m1", "t1.assistant"]);
    expect((t.sse.opts?.url as () => string)()).toBe("/api/chats/c1/stream");
    expect(t.sse.opts?.lastEventId?.()).toBe("1.20");
    expect(t.onChange).toHaveBeenCalled();
  });

  it("applies frames by their event name, and resets the live reply every time the stream opens", async () => {
    const t = setup();
    await t.transport.start();
    t.frame("answer", { turn: 2, text: "Hel" });
    expect(t.fold.value().entries.at(-1)).toMatchObject({ status: "streaming" });
    t.sse.opts?.onOpen?.(); // a reconnect
    expect(t.fold.value().entries.map((e) => e.id)).toEqual(["m1", "t1.assistant"]);
    t.frame("answer", { turn: 2, text: "Hello" }); // the snapshot
    t.frame("message", msg(4, "assistant", 2, { text: "Hello there" }));
    expect(t.fold.value().entries.at(-1)).toMatchObject({ id: "t2.assistant", status: "complete" });
  });

  it("drops a frame that is not one of ours, without applying it and without throwing", async () => {
    const t = setup();
    await t.transport.start();
    t.onChange.mockClear();
    t.frame("answer", { turn: "two" });
    t.frame("unheard-of", {});
    t.sse.opts?.onFrame({ event: "answer", data: "{not json", id: undefined });
    expect(t.onChange).not.toHaveBeenCalled();
    expect(t.fold.value().entries.length).toBe(2);
  });

  it("closes the stream for good on a closed frame, and reports the chat gone or rejected by the stream's own end", async () => {
    const t = setup();
    await t.transport.start();
    t.frame("closed", {});
    expect(t.sse.closed).toBe(true);
    const gone = setup();
    await gone.transport.start();
    gone.sse.opts?.onClose?.("not_found");
    expect(gone.onProblem).toHaveBeenCalledWith("gone");
    const rejected = setup();
    await rejected.transport.start();
    rejected.sse.opts?.onClose?.("rejected");
    expect(rejected.onProblem).toHaveBeenCalledWith("stream");
    const ours = setup();
    await ours.transport.start();
    ours.sse.opts?.onClose?.("closed"); // we closed it ourselves: not a problem
    expect(ours.onProblem).not.toHaveBeenCalled();
  });

  it("a failed first page is a 'load' problem (and 'gone' for a 404) and opens no stream", async () => {
    const down = setup(
      vi.fn(async () => {
        throw new ApiError(0, "network");
      }),
    );
    await down.transport.start();
    expect(down.onProblem).toHaveBeenCalledWith("load");
    expect(down.open).not.toHaveBeenCalled();
    const missing = setup(
      vi.fn(async () => {
        throw new ApiError(404, "not_found");
      }),
    );
    await missing.transport.start();
    expect(missing.onProblem).toHaveBeenCalledWith("gone");
  });

  it("loadOlder fetches the page before the window, one at a time, and stops at the start", async () => {
    const listMessages = vi.fn(async (_id: string, cursor?: string) =>
      cursor === undefined
        ? {
            items: [msg(3, "user", 2), msg(4, "assistant", 2)],
            nextCursor: "1.25" as string | null,
          }
        : { items: [msg(1, "user", 1), msg(2, "assistant", 1)], nextCursor: null },
    );
    const t = setup(listMessages as never);
    await t.transport.start();
    const first = t.transport.loadOlder();
    const second = t.transport.loadOlder(); // while the first is in flight: ignored
    await Promise.all([first, second]);
    expect(listMessages).toHaveBeenCalledTimes(2);
    expect(listMessages).toHaveBeenLastCalledWith("c1", "1.25");
    expect(t.fold.value().entries.map((e) => e.id)).toEqual([
      "m1",
      "t1.assistant",
      "m3",
      "t2.assistant",
    ]);
    await t.transport.loadOlder(); // the start is reached
    expect(listMessages).toHaveBeenCalledTimes(2);
  });

  it("close() closes the stream and silences later frames and pages", async () => {
    const t = setup();
    await t.transport.start();
    t.transport.close();
    expect(t.sse.closed).toBe(true);
    t.onChange.mockClear();
    t.frame("status", { state: "open", running: true, turns: 1 });
    await t.transport.loadOlder();
    expect(t.onChange).not.toHaveBeenCalled();
  });
});

describe("chat transport: terminal ends, auth, send and stop", () => {
  it("a stream that gives up (failed) is a stream problem; a 401 signs out the session it opened in", async () => {
    const t = setup();
    await t.transport.start();
    t.sse.opts?.onClose?.("failed");
    expect(t.onProblem).toHaveBeenCalledWith("stream");
    const u = setup();
    await u.transport.start();
    u.sse.opts?.onClose?.("unauthorized");
    expect(u.auth.expired).toHaveBeenCalledWith(7);
    expect(u.onProblem).not.toHaveBeenCalled();
  });

  it("a terminal error frame closes the stream and reports it (gone for not_found)", async () => {
    const t = setup();
    await t.transport.start();
    t.frame("error", { code: "internal" });
    expect(t.sse.closed).toBe(true);
    expect(t.fold.error).toBe(true);
    expect(t.onProblem).toHaveBeenCalledWith("stream");
    const g = setup();
    await g.transport.start();
    g.frame("error", { code: "not_found" });
    expect(g.onProblem).toHaveBeenCalledWith("gone");
  });

  it("send posts the text with a fresh key (and editOf when editing); stop reports whether a turn ran", async () => {
    const t = setup();
    await t.transport.start();
    await t.transport.send("Is it due?");
    await t.transport.send("Again?", 3);
    const [, first] = t.sendMessage.mock.calls[0] as unknown as [
      string,
      { text: string; messageId: string; editOf?: number },
    ];
    const [, second] = t.sendMessage.mock.calls[1] as unknown as [
      string,
      { messageId: string; editOf?: number },
    ];
    expect(first).toMatchObject({ text: "Is it due?" });
    expect("editOf" in first).toBe(false);
    expect(second.editOf).toBe(3);
    expect(first.messageId).not.toBe(second.messageId);
    expect(await t.transport.stop()).toBe(true);
    expect(t.stopChat).toHaveBeenCalledWith("c1");
  });

  it("message keys are version 4 UUIDs, which loom-ui accepts", () => {
    const k = newMessageKey();
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(k).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(newMessageKey()).not.toBe(k);
  });
});

describe("chat transport fix round 1", () => {
  it("a retry with the caller's key reuses it; without one each send gets a fresh key", async () => {
    const t = setup();
    await t.transport.start();
    await t.transport.send("Q", undefined, "retry-key-0123456789");
    await t.transport.send("Q", undefined, "retry-key-0123456789");
    const keys = t.sendMessage.mock.calls.map(
      (c) => (c as unknown as [string, { messageId: string }])[1].messageId,
    );
    expect(keys).toEqual(["retry-key-0123456789", "retry-key-0123456789"]);
  });
  it("the SSE event name is authoritative over a kind in the data", async () => {
    const t = setup();
    await t.transport.start();
    t.onChange.mockClear();
    t.frame("status", { kind: "closed", state: "open", running: true, turns: 1 });
    expect(t.sse.closed).toBe(false);
    expect(t.fold.value().running).toBe(true);
  });
});
