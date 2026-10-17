import { describe, expect, it } from "vitest";
import { ChatMessageDto, CreateChatRequest, PatchChatRequest, SendMessageRequest } from "./index";

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

  it("keeps locator fields it does not know yet", () => {
    const message = {
      id: "m1",
      role: "assistant",
      text: "See [[p1]].",
      citations: [
        {
          passageId: "p1",
          documentId: ID,
          docTitle: "Q3",
          locator: { kind: "page", page: 4 },
          snippet: "...",
        },
      ],
      createdAt: "2026-10-18T10:00:00.000Z",
    };
    expect(ChatMessageDto.parse(message).citations[0]?.locator).toEqual({ kind: "page", page: 4 });
  });
});
