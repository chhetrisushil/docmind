import { describe, expect, it } from "vitest";
import {
  ChatMessageDto,
  ChatReasoningDto,
  ChatSessionDto,
  ChatStreamEvent,
  CitationLocator,
  CreateChatRequest,
  Locator,
  PatchChatRequest,
  ReasoningQuery,
  ReasoningResponse,
  SendMessageRequest,
  SendMessageResponse,
  StopChatResponse,
} from "./index";

const ID = "11111111-1111-4111-8111-111111111111";

describe("chat contracts", () => {
  it("defaults a new chat's scope to all documents", () => {
    expect(CreateChatRequest.parse({})).toEqual({ scope: "all" });
  });

  it("accepts a document-list scope and rejects an empty one", () => {
    expect(CreateChatRequest.parse({ scope: { documentIds: [ID] } }).scope).toEqual({
      documentIds: [ID],
    });
    expect(CreateChatRequest.safeParse({ scope: { documentIds: [] } }).success).toBe(false);
    expect(CreateChatRequest.safeParse({ scope: "some" }).success).toBe(false);
  });

  it("requires a patch to change something", () => {
    expect(PatchChatRequest.safeParse({}).success).toBe(false);
    expect(PatchChatRequest.safeParse({ title: "Renamed" }).success).toBe(true);
  });

  it("rejects an empty or oversized message", () => {
    expect(SendMessageRequest.safeParse({ text: "   " }).success).toBe(false);
    expect(SendMessageRequest.safeParse({ text: "x".repeat(8001) }).success).toBe(false);
  });

  const message = {
    id: "12",
    turn: 6,
    role: "assistant",
    text: "See [[p1]].",
    status: "complete",
    citations: [
      {
        passageId: "p1",
        documentId: ID,
        docTitle: "Q3",
        locator: { kind: "page", page: 4 },
        snippet: "...",
      },
    ],
    cursor: "0.12",
    reasoning: { text: "Looking for the Q3 figures.", kind: "summary" },
    steps: [{ name: "search_docs", label: 'Searched documents: "Q3"', count: 8 }],
    outcome: null,
    createdAt: "2026-10-18T10:00:00.000Z",
  };

  it("keeps locator fields it does not know yet", () => {
    expect(ChatMessageDto.parse(message).citations[0]?.locator).toEqual({ kind: "page", page: 4 });
  });

  it("accepts every chunk locator kind as a citation locator, and not the old `heading`", () => {
    const chunkLocators = [
      { kind: "chars", start: 0, end: 5 },
      { kind: "section", index: 2 },
      { kind: "page", page: 3 },
      { kind: "paragraphs", from: 1, to: 2 },
      { kind: "region", page: 1, x: 0, y: 0, w: 1, h: 1 },
    ];
    for (const l of chunkLocators) {
      expect(Locator.safeParse(l).success).toBe(true);
      expect(CitationLocator.safeParse(l).success).toBe(true);
    }
    expect(CitationLocator.safeParse({ kind: "heading" }).success).toBe(false);
  });

  it("describes a message with its turn, status, reasoning, steps, outcome and cursor", () => {
    expect(ChatMessageDto.parse(message)).toEqual(message);
    expect(
      ChatMessageDto.parse({ ...message, outcome: "max_iterations", reasoning: null }).outcome,
    ).toBe("max_iterations");
    for (const reasoning of [
      { text: "", kind: "redacted" },
      { text: "", kind: "text", status: "erased" },
      { text: "", kind: "text", status: "digest-mismatch", truncated: true },
    ]) {
      expect(ChatMessageDto.parse({ ...message, reasoning }).reasoning).toEqual(reasoning);
      expect(ChatReasoningDto.parse(reasoning)).toEqual(reasoning);
    }
  });

  it("refuses a reasoning kind or status it does not know, a missing cursor and the old thinking field's shape", () => {
    for (const bad of [
      { reasoning: { text: "x", kind: "thought" } },
      { reasoning: { text: "x", kind: "summary", status: "lost" } },
      { reasoning: { text: "x", kind: "summary", truncated: false } },
      { reasoning: "plain string" },
      { cursor: "" },
    ]) {
      expect(ChatMessageDto.safeParse({ ...message, ...bad }).success).toBe(false);
    }
    const { cursor: _cursor, ...noCursor } = message;
    expect(ChatMessageDto.safeParse(noCursor).success).toBe(false);
  });

  it("parses Loom's durable reasoning body and refuses an unknown part status", () => {
    const body = {
      steps: [
        {
          stepId: "conv#o1#turn:0",
          recordedAttempt: 1,
          attempts: [
            {
              attempt: 1,
              provider: "anthropic",
              model: "claude-opus-5-5",
              recorded: true,
              parts: [
                { kind: "summary", status: "ok", text: "Looking." },
                { kind: "redacted", status: "redacted" },
              ],
            },
          ],
        },
      ],
      truncated: true,
    };
    expect(ReasoningResponse.parse(body)).toEqual(body);
    expect(ReasoningResponse.parse({ steps: [] })).toEqual({ steps: [] });
    const bad = {
      steps: [
        {
          stepId: "conv#o1#turn:0",
          attempts: [
            {
              attempt: 1,
              provider: "anthropic",
              recorded: true,
              parts: [{ kind: "summary", status: "lost" }],
            },
          ],
        },
      ],
    };
    expect(ReasoningResponse.safeParse(bad).success).toBe(false);
    expect(ReasoningQuery.parse({ cursor: "0.12" })).toEqual({ cursor: "0.12" });
    expect(ReasoningQuery.safeParse({}).success).toBe(false);
  });

  it("refuses a message id that is not a decimal ordinal, an unknown status, outcome or tool", () => {
    for (const bad of [
      { id: "m1" },
      { id: "-1" },
      { id: "01" },
      { status: "done" },
      { outcome: "timeout" },
      { steps: [{ name: "browse", label: "x", count: 1 }] },
      { steps: [{ name: "related", label: "x", count: -1 }] },
    ]) {
      expect(ChatMessageDto.safeParse({ ...message, ...bad }).success).toBe(false);
    }
  });

  it("describes a session by a uuid, with a null title until one is set", () => {
    const session = {
      id: ID,
      title: null,
      scope: "all",
      createdAt: "2026-10-18T10:00:00.000Z",
      lastMessageAt: null,
      messageCount: 0,
    };
    expect(ChatSessionDto.parse(session)).toEqual(session);
    expect(ChatSessionDto.safeParse({ ...session, id: "chat-1" }).success).toBe(false);
  });

  it("accepts an idempotency id and an edit target on a send, and refuses malformed ones", () => {
    expect(SendMessageRequest.parse({ text: " hi ", messageId: ID, editOf: 1 })).toEqual({
      text: "hi",
      messageId: ID,
      editOf: 1,
    });
    expect(SendMessageRequest.parse({ text: "hi" })).toEqual({ text: "hi" });
    expect(SendMessageRequest.safeParse({ text: "hi", messageId: "m1" }).success).toBe(false);
    expect(SendMessageRequest.safeParse({ text: "hi", editOf: 0 }).success).toBe(false);
    expect(SendMessageRequest.safeParse({ text: "hi", editOf: -1 }).success).toBe(false);
    expect(SendMessageRequest.safeParse({ text: "hi", editOf: 1.5 }).success).toBe(false);
  });

  it("types the send and stop responses", () => {
    expect(SendMessageResponse.parse({ messageId: "5" })).toEqual({ messageId: "5" });
    expect(StopChatResponse.parse({ stopped: false })).toEqual({ stopped: false });
    expect(StopChatResponse.safeParse({ stopped: "yes" }).success).toBe(false);
  });

  it("parses every stream event kind and refuses an unknown one", () => {
    const events = [
      { kind: "status", state: "open", running: false, turns: 0 },
      { kind: "message", message },
      { kind: "reasoning", turn: 3, text: "..." },
      { kind: "reasoning-partial", turn: 3, text: "so far" },
      { kind: "tool", turnKey: 3, step: message.steps[0] },
      { kind: "tool-reset", turnKey: 5 },
      { kind: "answer", turn: 3, text: "The" },
      { kind: "reset", turn: 3 },
      { kind: "closed" },
      { kind: "error", code: "internal" },
    ];
    for (const e of events) expect(ChatStreamEvent.parse(e)).toEqual(e);
    expect(ChatStreamEvent.safeParse({ kind: "delta", text: "x" }).success).toBe(false);
    expect(ChatStreamEvent.safeParse({ kind: "error" }).success).toBe(false);
    expect(ChatStreamEvent.safeParse({ kind: "error", code: "boom" }).success).toBe(false);
    expect(ChatStreamEvent.safeParse({ kind: "thinking", turnKey: 3, text: "x" }).success).toBe(
      false,
    );
    expect(ChatStreamEvent.safeParse({ kind: "reasoning", turnKey: 3, text: "x" }).success).toBe(
      false,
    );
    expect(ChatStreamEvent.safeParse({ kind: "reasoning", turn: 0, text: "x" }).success).toBe(
      false,
    );
    expect(ChatStreamEvent.safeParse({ kind: "reset", turnKey: 5 }).success).toBe(false);
  });
});
