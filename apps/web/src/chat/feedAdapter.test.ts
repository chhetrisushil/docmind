import type { ChatMessageDto, ChatStreamEvent } from "@docmind/contracts";
import { describe, expect, it } from "vitest";
import { ChatFold, entryIdOf, wireOfMessage } from "./feedAdapter";

const PASSAGE = "c0ffee00-0000-4000-8000-000000000001";
const DOC = "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11";
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
const page = (items: ChatMessageDto[], nextCursor: string | null = null) => ({ items, nextCursor });
const ev = (e: unknown) => e as ChatStreamEvent;
const text = (fold: ChatFold) =>
  fold
    .value()
    .entries.map((e) => [e.id, e.status, (e.parts?.[0] as { text: string } | undefined)?.text]);

describe("entryIdOf / wireOfMessage", () => {
  it("names an assistant entry by its turn and a user entry by its record ordinal", () => {
    expect(entryIdOf(msg(2, "assistant", 1))).toBe("t1.assistant");
    expect(entryIdOf(msg(1, "user", 1))).toBe("m1");
    expect(entryIdOf(msg(7, "user", 0, { status: "rejected" }))).toBe("m7");
  });
  it("maps the DTO to the feed's wire shape and a failed or cut-short reply to a fixed reason token", () => {
    const wire = wireOfMessage(msg(2, "assistant", 1, { status: "failed" }));
    expect(wire).toMatchObject({
      turn: 1,
      role: "assistant",
      status: "failed",
      cursor: "1.20",
      ord: 2,
      reason: "model-error",
      at: Date.parse("2026-10-21T10:00:00.000Z"),
    });
    expect(wireOfMessage(msg(2, "assistant", 1, { outcome: "refusal" }))).toMatchObject({
      reason: "refusal",
    });
    expect(wireOfMessage(msg(2, "assistant", 1, { outcome: "max_tokens" }))).toMatchObject({
      reason: "max-tokens",
    });
    expect(wireOfMessage(msg(2, "assistant", 1, { outcome: "max_iterations" }))).toMatchObject({
      reason: "max-iterations",
    });
    expect(wireOfMessage(msg(1, "user", 0, { status: "rejected" }))).toMatchObject({
      reason: "rejected",
      turn: 0,
    });
    expect("reason" in wireOfMessage(msg(2, "assistant", 1))).toBe(false);
  });
  it("lists the cited passage ids once each as the wire's refs, and none when nothing is cited", () => {
    const c = {
      passageId: PASSAGE,
      documentId: DOC,
      docTitle: "Doc",
      locator: { kind: "page" as const, page: 3 },
      snippet: "snip",
    };
    expect(wireOfMessage(msg(2, "assistant", 1, { citations: [c, c] }))).toMatchObject({
      refs: [PASSAGE],
    });
    expect("refs" in wireOfMessage(msg(2, "assistant", 1))).toBe(false);
  });
  it("the fold's value says the source writes markers, and the reply carries its refs", () => {
    const fold = new ChatFold();
    const c = {
      passageId: PASSAGE,
      documentId: DOC,
      docTitle: "Doc",
      locator: { kind: "page" as const, page: 3 },
      snippet: "snip",
    };
    fold.applyHistory({
      items: [
        msg(1, "user", 1),
        msg(2, "assistant", 1, { text: `Due [[${PASSAGE}]].`, citations: [c] }),
      ],
      nextCursor: null,
    });
    expect(fold.value().refMarkers).toBe(true);
    expect(fold.value().entries[1]?.refs).toEqual([{ id: PASSAGE }]);
  });
  it("marks the assistant's text as markdown, live and durable, and never the user's question", () => {
    const fold = new ChatFold();
    fold.applyHistory(
      page([
        msg(1, "user", 1, { text: "Is it **due**?" }),
        msg(2, "assistant", 1, { text: "Yes, in **30 days**." }),
      ]),
    );
    fold.applyStream(ev({ kind: "answer", turn: 2, text: "Next: **bo" }));
    const [asked, answered, live] = fold.value().entries;
    expect(asked?.parts).toEqual([{ type: "text", text: "Is it **due**?" }]);
    expect(answered?.parts).toEqual([
      { type: "text", text: "Yes, in **30 days**.", format: "markdown" },
    ]);
    expect(live).toMatchObject({
      status: "streaming",
      parts: [{ type: "text", text: "Next: **bo", format: "markdown" }],
    });
  });
});

describe("ChatFold history", () => {
  it("folds a page (oldest first, as the server sends it) into entries in order, with their extras kept beside", () => {
    const fold = new ChatFold();
    const cited = msg(2, "assistant", 1, {
      citations: [
        {
          passageId: PASSAGE,
          documentId: DOC,
          docTitle: "Doc",
          locator: { kind: "page", page: 3 },
          snippet: "snip",
        },
      ],
      steps: [{ name: "search_docs", label: "Searched documents", count: 8 }],
      reasoning: { text: "I looked", kind: "summary" },
    });
    fold.applyHistory(
      page([msg(1, "user", 1), cited, msg(3, "user", 2), msg(4, "assistant", 2)], "1.5"),
    );
    expect(text(fold).map((r) => r[0])).toEqual(["m1", "t1.assistant", "m3", "t2.assistant"]);
    expect(fold.olderCursor).toBe("1.5");
    expect(fold.historyLoaded).toBe(true);
    expect(fold.extrasOf("t1.assistant")).toMatchObject({
      ord: 2,
      citations: [{ passageId: PASSAGE }],
      steps: [{ count: 8 }],
      reasoning: { text: "I looked" },
      outcome: null,
    });
    expect(fold.extrasOf("m1")).toMatchObject({ ord: 1, citations: [] });
  });

  it("an older page goes in front, and the start of the chat clears the older cursor", () => {
    const fold = new ChatFold();
    fold.applyHistory(page([msg(3, "user", 2), msg(4, "assistant", 2)], "1.25"));
    fold.applyHistory(page([msg(1, "user", 1), msg(2, "assistant", 1)], null));
    expect(text(fold).map((r) => r[0])).toEqual(["m1", "t1.assistant", "m3", "t2.assistant"]);
    expect(fold.olderCursor).toBeNull();
  });

  it("keeps a rejected message (turn 0) so the user sees why it was refused, without its text", () => {
    const fold = new ChatFold();
    fold.applyHistory(
      page([msg(1, "user", 0, { status: "rejected", text: "sentinel-question-0123456789" })]),
    );
    const [entry] = fold.value().entries;
    expect(entry).toMatchObject({ id: "m1", status: "rejected" });
    expect(JSON.stringify(entry)).not.toContain("sentinel-question");
  });
});

describe("ChatFold stream", () => {
  it("folds status, reasoning, answer deltas and the durable message: the live reply becomes the durable one in place", () => {
    const fold = new ChatFold();
    fold.applyHistory(page([msg(1, "user", 1)]));
    fold.applyStream(ev({ kind: "status", state: "open", running: true, turns: 1 }));
    expect(fold.value().running).toBe(true);
    fold.applyStream(ev({ kind: "reasoning-partial", turn: 1, text: "Looking" }));
    fold.applyStream(ev({ kind: "reasoning", turn: 1, text: " at the invoice" }));
    fold.applyStream(ev({ kind: "answer", turn: 1, text: "Due " }));
    fold.applyStream(ev({ kind: "answer", turn: 1, text: "in 30 days" }));
    const live = fold.value().entries[1];
    expect(live).toMatchObject({
      id: "t1.assistant",
      status: "streaming",
      reasoning: { text: "Looking at the invoice", streaming: true },
    });
    expect(text(fold)[1]).toEqual(["t1.assistant", "streaming", "Due in 30 days"]);
    fold.applyStream(
      ev({
        kind: "tool",
        turnKey: 1,
        step: { name: "search_docs", label: "Searched documents", count: 8 },
      }),
    );
    expect(fold.liveSteps).toHaveLength(1);
    const done = msg(2, "assistant", 1, {
      text: "Due in 30 days.",
      steps: [{ name: "search_docs", label: "Searched documents", count: 8 }],
    });
    fold.applyStream(ev({ kind: "message", ...done }));
    expect(text(fold)[1]).toEqual(["t1.assistant", "complete", "Due in 30 days."]);
    expect(fold.value().entries[1]?.reasoning).toMatchObject({
      text: "Looking at the invoice",
      streaming: false,
    });
    expect(fold.liveSteps).toEqual([]);
    expect(fold.extrasOf("t1.assistant")?.steps).toHaveLength(1);
  });

  it("tool steps pile up for the reply in flight and are dropped by tool-reset and reset", () => {
    const fold = new ChatFold();
    const step = { name: "search_docs" as const, label: "Searched documents", count: 1 };
    fold.applyStream(ev({ kind: "tool", turnKey: 1, step }));
    fold.applyStream(ev({ kind: "tool", turnKey: 1, step }));
    expect(fold.liveSteps).toHaveLength(2);
    fold.applyStream(ev({ kind: "tool-reset", turnKey: 1 }));
    expect(fold.liveSteps).toEqual([]);
    fold.applyStream(ev({ kind: "tool", turnKey: 1, step }));
    fold.applyStream(ev({ kind: "reset", turn: 1 }));
    expect(fold.liveSteps).toEqual([]);
  });

  it("a reply that restarts (reset) loses its live text and reasoning", () => {
    const fold = new ChatFold();
    fold.applyHistory(page([msg(1, "user", 1)]));
    fold.applyStream(ev({ kind: "answer", turn: 1, text: "half an answer" }));
    fold.applyStream(ev({ kind: "reasoning-partial", turn: 1, text: "half a thought" }));
    fold.applyStream(ev({ kind: "reset", turn: 1 }));
    expect(fold.value().entries.map((e) => e.id)).toEqual(["m1"]);
  });

  it("resetLive empties the reply in flight so the snapshot a reconnect starts with does not double the text", () => {
    const fold = new ChatFold();
    fold.applyHistory(page([msg(1, "user", 1)]));
    fold.applyStream(ev({ kind: "reasoning-partial", turn: 1, text: "Thinking" }));
    fold.applyStream(ev({ kind: "answer", turn: 1, text: "Hello" }));
    fold.applyStream(
      ev({ kind: "tool", turnKey: 1, step: { name: "search_docs", label: "L", count: 1 } }),
    );
    fold.resetLive(); // the stream just (re)opened
    expect(fold.liveSteps).toEqual([]);
    fold.applyStream(ev({ kind: "reasoning-partial", turn: 1, text: "Thinking more" })); // the server's snapshot
    fold.applyStream(ev({ kind: "answer", turn: 1, text: "Hello wor" }));
    expect(text(fold)[1]).toEqual(["t1.assistant", "streaming", "Hello wor"]);
    expect(fold.value().entries[1]?.reasoning?.text).toBe("Thinking more");
  });

  it("closed and error frames: the chat closes, and an error is remembered", () => {
    const fold = new ChatFold();
    fold.applyStream(ev({ kind: "closed" }));
    expect(fold.value().state).toBe("closed");
    expect(fold.error).toBe(false);
    fold.applyStream(ev({ kind: "error", code: "internal" }));
    expect(fold.error).toBe(true);
  });

  it("ignores a frame the feed refuses, without throwing, and exposes the newest durable cursor to resume from", () => {
    const fold = new ChatFold();
    fold.applyStream(ev({ kind: "answer", turn: 0, text: "x" }));
    expect(fold.value().entries).toEqual([]);
    fold.applyHistory(page([msg(1, "user", 1), msg(2, "assistant", 1)]));
    expect(fold.resumeCursor()).toBe("1.20");
  });
});
