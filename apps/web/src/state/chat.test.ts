import type { ChatMessageDto, ListMessagesResponse, SendMessageRequest } from "@docmind/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import type { SseOptions } from "../api/sse";
import { ChatController, problemText, sourcesOf } from "./chat";

const PASSAGE = "c0ffee00-0000-4000-8000-000000000001";
const DOC = "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11";
const cited = {
  passageId: PASSAGE,
  documentId: DOC,
  docTitle: "Doc",
  locator: { kind: "page" as const, page: 2 },
  snippet: "snip",
};
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

type ListFn = (id: string, cursor?: string) => Promise<ListMessagesResponse>;
type SendFn = (id: string, req: SendMessageRequest) => Promise<{ messageId: string }>;
type StopFn = (id: string) => Promise<{ stopped: boolean }>;

function setup(over: { listMessages?: ListFn; sendMessage?: SendFn; stopChat?: StopFn } = {}) {
  const api = {
    listMessages: vi.fn<ListFn>(async () => ({
      items: [
        msg(1, "user", 1),
        msg(2, "assistant", 1, {
          citations: [cited],
          steps: [{ name: "search_docs", label: "Searched documents", count: 8 }],
          reasoning: { text: "I looked", kind: "summary" },
        }),
      ],
      nextCursor: "1.5",
    })),
    sendMessage: vi.fn<SendFn>(async () => ({ messageId: "m" })),
    stopChat: vi.fn<StopFn>(async () => ({ stopped: true })),
  };
  if (over.listMessages) api.listMessages = vi.fn<ListFn>(over.listMessages);
  if (over.sendMessage) api.sendMessage = vi.fn<SendFn>(over.sendMessage);
  if (over.stopChat) api.stopChat = vi.fn<StopFn>(over.stopChat);
  const sse: { opts?: SseOptions } = {};
  const open = vi.fn((opts: SseOptions) => {
    sse.opts = opts;
    return { close: vi.fn() };
  });
  const onActivity = vi.fn();
  const auth = { epoch: 3, expired: vi.fn() };
  const ctl = new ChatController({ api, auth, chatId: "c1", open: open as never, onActivity });
  const frame = (event: string, data: unknown) =>
    sse.opts?.onFrame({ event, data: JSON.stringify(data), id: undefined });
  return { ctl, api, auth, sse, open, onActivity, frame, state: () => ctl.state.get() };
}

const bodyOf = (t: ReturnType<typeof setup>, n = 0): SendMessageRequest => {
  const call = t.api.sendMessage.mock.calls[n];
  if (!call) throw new Error("no call");
  return call[1];
};

describe("ChatController: loading", () => {
  it("starts loading, then shows the history with citations, steps and reasoning beside each reply", async () => {
    const t = setup();
    expect(t.state()).toMatchObject({ loading: true, entries: [] });
    await t.ctl.start();
    const s = t.state();
    expect(s).toMatchObject({
      loading: false,
      hasOlder: true,
      running: false,
      pending: false,
      sourcesOpen: true,
    });
    expect(s.entries.map((e) => [e.id, e.role, e.text])).toEqual([
      ["m1", "user", "user 1"],
      ["t1.assistant", "assistant", "assistant 2"],
    ]);
    expect(s.entries[1]).toMatchObject({
      turn: 1,
      ord: 2,
      citations: [cited],
      steps: [{ count: 8 }],
      reasoning: { text: "I looked", kind: "summary", streaming: false },
      outcome: null,
    });
  });

  it("maps the transport's problems onto the state", async () => {
    const down = setup({
      listMessages: async () => {
        throw new ApiError(0, "network");
      },
    });
    await down.ctl.start();
    expect(down.state()).toMatchObject({ loading: false, problem: "load" });
    const gone = setup({
      listMessages: async () => {
        throw new ApiError(404, "not_found");
      },
    });
    await gone.ctl.start();
    expect(gone.state().problem).toBe("gone");
  });

  it("loadOlder prepends the earlier page and clears hasOlder at the start of the chat", async () => {
    const listMessages: ListFn = async (_id, cursor) =>
      cursor === undefined
        ? { items: [msg(3, "user", 2), msg(4, "assistant", 2)], nextCursor: "1.25" }
        : { items: [msg(1, "user", 1), msg(2, "assistant", 1)], nextCursor: null };
    const t = setup({ listMessages });
    await t.ctl.start();
    const pending = t.ctl.loadOlder();
    expect(t.state().loadingOlder).toBe(true);
    await pending;
    expect(t.state()).toMatchObject({ loadingOlder: false, hasOlder: false });
    expect(t.state().entries.map((e) => e.id)).toEqual([
      "m1",
      "t1.assistant",
      "m3",
      "t2.assistant",
    ]);
  });
});

describe("ChatController: sending", () => {
  it("sends the trimmed text with a fresh message id, shows the reply as pending until one arrives, and tells the sidebar", async () => {
    const t = setup();
    await t.ctl.start();
    expect(await t.ctl.send("  And the interest?  ")).toBe("sent");
    const body = bodyOf(t);
    expect(t.api.sendMessage.mock.calls[0]?.[0]).toBe("c1");
    expect(body.text).toBe("And the interest?");
    expect(body.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect("editOf" in body).toBe(false);
    expect(t.state()).toMatchObject({ running: true, pending: true });
    expect(t.onActivity).toHaveBeenCalledTimes(1);
    t.frame("message", msg(3, "user", 2, { text: "And the interest?" }));
    expect(t.state().pending).toBe(true); // the user's turn is in, the reply is not
    t.frame("message", msg(4, "assistant", 2, { text: "Five percent." }));
    expect(t.state()).toMatchObject({ running: false, pending: false });
    expect(t.state().entries.at(-1)).toMatchObject({
      id: "t2.assistant",
      text: "Five percent.",
      status: "complete",
    });
  });

  it("does not send an empty message, and reports a refusal in a word", async () => {
    const t = setup();
    await t.ctl.start();
    expect(await t.ctl.send("   ")).toBe("failed");
    expect(t.api.sendMessage).not.toHaveBeenCalled();
    for (const [err, outcome] of [
      [new ApiError(503, "chat_unavailable"), "unavailable"],
      [new ApiError(429, "too_many_requests"), "busy"],
      [new ApiError(0, "network"), "failed"],
      [new ApiError(500, "internal"), "failed"],
    ] as const) {
      const f = setup({
        sendMessage: async () => {
          throw err;
        },
      });
      await f.ctl.start();
      expect(await f.ctl.send("hi")).toBe(outcome);
      expect(f.state().pending).toBe(false);
      expect(f.state().running).toBe(false);
    }
    const u = setup({
      sendMessage: async () => {
        throw new ApiError(503, "chat_unavailable");
      },
    });
    await u.ctl.start();
    await u.ctl.send("hi");
    expect(u.state().problem).toBe("unavailable");
  });

  it("regenerate re-sends the question the reply answered, as an edit of that message", async () => {
    const t = setup();
    await t.ctl.start();
    expect(await t.ctl.regenerate("t1.assistant")).toBe("sent");
    expect(t.api.sendMessage).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ text: "user 1", editOf: 1 }),
    );
    expect(await t.ctl.regenerate("t9.assistant")).toBe("failed"); // no such reply
    expect(await t.ctl.regenerate("m1")).toBe("failed"); // not a reply
    expect(t.api.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("stop asks the server and stops waiting", async () => {
    const t = setup();
    await t.ctl.start();
    await t.ctl.send("hi");
    expect(t.state().running).toBe(true);
    await t.ctl.stop();
    expect(t.api.stopChat).toHaveBeenCalledWith("c1");
    expect(t.state().running).toBe(false);
  });

  it("a message the server rejects ends the wait, and so does a closed chat", async () => {
    const t = setup();
    await t.ctl.start();
    await t.ctl.send("hi");
    expect(t.state().pending).toBe(true);
    t.frame("message", msg(3, "user", 0, { status: "rejected", text: "" }));
    expect(t.state()).toMatchObject({ running: false, pending: false });
    await t.ctl.send("again");
    t.frame("closed", {});
    expect(t.state()).toMatchObject({ running: false, pending: false, closed: true });
  });

  it("a chat opened in the middle of a turn shows the reply as pending, whatever the stale status frame says", async () => {
    const t = setup({
      listMessages: async () => ({ items: [msg(1, "user", 1)], nextCursor: null }),
    });
    await t.ctl.start();
    expect(t.state()).toMatchObject({ pending: true, running: true });
    t.frame("status", { state: "open", running: false, turns: 1 }); // a stale or wrong status changes nothing
    expect(t.state().pending).toBe(true);
    t.frame("message", msg(2, "assistant", 1));
    expect(t.state()).toMatchObject({ pending: false, running: false });
  });
});

describe("ChatController: a reply arriving", () => {
  it("shows thinking, tool steps and the answer as they come, and the reply is the durable one at the end", async () => {
    const t = setup();
    await t.ctl.start();
    await t.ctl.send("Q?");
    t.frame("message", msg(3, "user", 2, { text: "Q?" }));
    t.frame("status", { state: "open", running: true, turns: 2 });
    t.frame("tool", {
      turnKey: 3,
      step: { name: "search_docs", label: "Searched documents", count: 2 },
    });
    expect(t.state()).toMatchObject({ pending: true, liveSteps: [{ count: 2 }] });
    t.frame("reasoning-partial", { turn: 2, text: "Thinking" });
    let last = t.state().entries.at(-1);
    expect(last).toMatchObject({
      role: "assistant",
      status: "streaming",
      reasoning: { text: "Thinking", streaming: true },
    });
    expect(t.state().pending).toBe(false);
    expect(last?.steps).toEqual([{ name: "search_docs", label: "Searched documents", count: 2 }]); // the live steps ride on the streaming reply
    t.frame("answer", { turn: 2, text: "Due " });
    t.frame("answer", { turn: 2, text: "soon" });
    last = t.state().entries.at(-1);
    expect(last).toMatchObject({ text: "Due soon", status: "streaming" });
    t.frame(
      "message",
      msg(4, "assistant", 2, {
        text: "Due soon.",
        steps: [{ name: "search_docs", label: "Searched documents", count: 2 }],
        citations: [cited],
      }),
    );
    expect(t.state()).toMatchObject({ running: false, liveSteps: [] });
    expect(t.state().entries.at(-1)).toMatchObject({
      status: "complete",
      text: "Due soon.",
      citations: [cited],
      reasoning: { text: "Thinking", streaming: false },
    });
    expect(t.onActivity.mock.calls.length).toBeGreaterThanOrEqual(2); // after the send and when the turn ended
  });

  it("failed and cut-short replies carry their reason", async () => {
    const t = setup();
    await t.ctl.start();
    t.frame("message", msg(3, "user", 2));
    t.frame("message", msg(4, "assistant", 2, { status: "failed", text: "" }));
    expect(t.state().entries.at(-1)).toMatchObject({ status: "failed", reason: "model-error" });
    t.frame("message", msg(5, "user", 3));
    t.frame(
      "message",
      msg(6, "assistant", 3, { outcome: "refusal", text: "I cannot help with that." }),
    );
    expect(t.state().entries.at(-1)).toMatchObject({ outcome: "refusal", reason: "refusal" });
  });
});

describe("ChatController: sources", () => {
  it("shows the newest reply with citations by default, follows a selection, and ignores a repeat of the same one", async () => {
    const t = setup();
    await t.ctl.start();
    expect(sourcesOf(t.state())).toMatchObject({
      entry: { id: "t1.assistant" },
      passageId: undefined,
    });
    const seen = vi.fn();
    t.ctl.state.subscribe(seen);
    t.ctl.select("t1.assistant", PASSAGE);
    expect(sourcesOf(t.state())).toMatchObject({
      entry: { id: "t1.assistant" },
      passageId: PASSAGE,
    });
    expect(t.state().sourcesOpen).toBe(true);
    t.ctl.select("t1.assistant", PASSAGE);
    expect(seen).toHaveBeenCalledTimes(1);
    t.ctl.toggleSources(false);
    expect(t.state().sourcesOpen).toBe(false);
    t.ctl.toggleSources();
    expect(t.state().sourcesOpen).toBe(true);
  });
  it("has no sources to show when no reply cites anything", async () => {
    const t = setup({
      listMessages: async () => ({
        items: [msg(1, "user", 1), msg(2, "assistant", 1)],
        nextCursor: null,
      }),
    });
    await t.ctl.start();
    expect(sourcesOf(t.state()).entry).toBeUndefined();
  });
});

describe("ChatController: the transcript for the Chat widget", () => {
  it("carries the tool line, the stored reasoning and the cited ids of a reply from history, as loom-ui's contract wants them", async () => {
    const t = setup();
    await t.ctl.start();
    const reply = t.state().transcript.entries[1];
    expect(reply).toMatchObject({
      id: "t1.assistant",
      tools: [{ name: "Searched documents (8)", status: "done" }],
      reasoning: { text: "I looked", kind: "summary", streaming: false },
      refs: [{ id: PASSAGE }],
    });
    expect(t.state().transcript.refMarkers).toBe(true);
  });
});

describe("ChatController: close", () => {
  it("closes the transport, and later frames change nothing", async () => {
    const t = setup();
    await t.ctl.start();
    t.ctl.close();
    const before = t.state();
    t.frame("message", msg(3, "user", 2));
    expect(t.state()).toBe(before);
  });
});

describe("ChatController: one key per intent, guards, and settling", () => {
  it("retries a send that may have landed with the same key, and gives a new intent a new key", async () => {
    let n = 0;
    const t = setup({
      sendMessage: async () => {
        n += 1;
        if (n === 1) throw new ApiError(0, "network");
        return { messageId: "m" };
      },
    });
    await t.ctl.start();
    expect(await t.ctl.send("same")).toBe("failed");
    expect(await t.ctl.send("same")).toBe("sent");
    expect(bodyOf(t, 1).messageId).toBe(bodyOf(t, 0).messageId);
    await t.ctl.send("other");
    expect(bodyOf(t, 2).messageId).not.toBe(bodyOf(t, 0).messageId);
    await t.ctl.send("same");
    expect(bodyOf(t, 3).messageId).not.toBe(bodyOf(t, 0).messageId);
  });

  it("a definite refusal ends the intent: the next try uses a new key", async () => {
    let n = 0;
    const t = setup({
      sendMessage: async () => {
        n += 1;
        if (n === 1) throw new ApiError(500, "internal");
        return { messageId: "m" };
      },
    });
    await t.ctl.start();
    await t.ctl.send("x");
    await t.ctl.send("x");
    expect(bodyOf(t, 1).messageId).not.toBe(bodyOf(t, 0).messageId);
  });

  it("uses the widget's key for a chat.send intent", async () => {
    const t = setup();
    await t.ctl.start();
    await t.ctl.perform({ type: "chat.send", text: "hi", key: "key-0123456789abcdef" });
    expect(bodyOf(t).messageId).toBe("key-0123456789abcdef");
  });

  it("ignores a second send while the first is in flight, and a second stop while one is", async () => {
    let release: () => void = () => {};
    const t = setup({
      sendMessage: () =>
        new Promise((r) => {
          release = () => r({ messageId: "m" });
        }),
    });
    await t.ctl.start();
    const first = t.ctl.send("hi");
    expect(await t.ctl.send("hi")).toBe("busy");
    expect(await t.ctl.regenerate("t1.assistant")).toBe("busy");
    release();
    expect(await first).toBe("sent");
    expect(t.api.sendMessage).toHaveBeenCalledTimes(1);
    let done: () => void = () => {};
    const s = setup({
      stopChat: () =>
        new Promise((r) => {
          done = () => r({ stopped: true });
        }),
    });
    await s.ctl.start();
    const a = s.ctl.stop();
    const b = s.ctl.stop();
    done();
    await Promise.all([a, b]);
    expect(s.api.stopChat).toHaveBeenCalledTimes(1);
  });

  it("regenerate skips a rejected question and answers the last accepted one", async () => {
    const t = setup({
      listMessages: async () => ({
        items: [
          msg(1, "user", 1),
          msg(2, "assistant", 1),
          msg(3, "user", 0, { status: "rejected", text: "" }),
        ],
        nextCursor: null,
      }),
    });
    await t.ctl.start();
    t.frame("message", msg(4, "user", 2, { text: "second" }));
    t.frame("message", msg(5, "assistant", 2, { text: "ans" }));
    expect(await t.ctl.regenerate("t2.assistant")).toBe("sent");
    expect(bodyOf(t)).toMatchObject({ text: "second", editOf: 4 });
  });

  it("stop settles a user turn that never got a reply", async () => {
    const t = setup({
      listMessages: async () => ({ items: [msg(1, "user", 1)], nextCursor: null }),
    });
    await t.ctl.start();
    expect(t.state().running).toBe(true);
    await t.ctl.stop();
    expect(t.state()).toMatchObject({ running: false, pending: false });
  });

  it("a stream problem or a lost stream settles the wait and maps to a fixed sentence", async () => {
    const t = setup();
    await t.ctl.start();
    await t.ctl.send("hi");
    t.frame("message", msg(3, "user", 2));
    expect(t.state().running).toBe(true);
    t.sse.opts?.onClose?.("failed");
    expect(t.state()).toMatchObject({ running: false, pending: false, problem: "stream" });
    for (const p of ["load", "stream", "gone", "unavailable"] as const)
      expect(problemText(p)).not.toBe("");
  });

  it("a 401 on the stream signs out for the epoch the stream was opened in", async () => {
    const t = setup();
    await t.ctl.start();
    t.sse.opts?.onClose?.("unauthorized");
    expect(t.auth.expired).toHaveBeenCalledWith(3);
  });
});

describe("ChatController: widget actions", () => {
  it("holds the served refs by entry, and performs a citation, older-page and send intent", async () => {
    const t = setup();
    await t.ctl.start();
    expect(t.ctl.heldRefs()).toEqual(new Map([["t1.assistant", [PASSAGE]]]));
    await t.ctl.perform({ type: "chat.cite", entryId: "t1.assistant", refId: PASSAGE });
    expect(sourcesOf(t.state())).toMatchObject({
      entry: { id: "t1.assistant" },
      passageId: PASSAGE,
    });
    await t.ctl.perform({ type: "chat.older" });
    expect(t.api.listMessages).toHaveBeenLastCalledWith("c1", "1.5");
  });
});
