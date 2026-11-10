import { describe, expect, it } from "vitest";
import { CHAT_EFFECT_IDS, CHAT_FLOW_ID, CHAT_GK_FLOW_ID, CHAT_TITLE_FLOW_ID } from "./chats/ids";
import { SUGGEST_TAGS_FLOW_ID } from "./flows/suggest-tags/flow";
import { authorizer, executionAuthorizer } from "./security";

const request = (workflowId: string, toolId: string) => ({
  workflowId,
  toolId,
  executionId: "u_x",
  stepId: "s",
});

describe("the execution policy", () => {
  // The nine ops Loom's createConversations requires to be "owner" or "deny" (conversations.ts POLICED_OPS).
  const POLICED = [
    "query",
    "send",
    "cancel",
    "resume",
    "actAsOwner",
    "annotate",
    "discard",
    "quarantine",
    "release",
  ] as const;

  it("scopes every op createConversations polices to owner or deny", () => {
    for (const op of POLICED) expect(["owner", "deny"]).toContain(executionAuthorizer.scopes[op]);
  });

  it("scopes send to the owner (a tenant peer cannot message another user's chat)", () => {
    expect(executionAuthorizer.scopes.send).toBe("owner");
  });
});

describe("the effect grants", () => {
  it.each([CHAT_FLOW_ID, CHAT_GK_FLOW_ID])(
    "lets %s call the model and each tool, and nothing else",
    (flow) => {
      for (const id of CHAT_EFFECT_IDS)
        expect(authorizer.authorize(request(flow, id)).allowed).toBe(true);
      for (const id of [
        "ingest-parse",
        "chat-title",
        "conversation.turn",
        "summarize",
        "write_file",
      ]) {
        expect(authorizer.authorize(request(flow, id)).allowed).toBe(false);
      }
    },
  );

  it("grants visualize-turn exactly its four steps", () => {
    for (const tool of ["turn-load", "turn-extract", "turn-facts", "turn-commit"])
      expect(authorizer.authorize(request("visualize-turn", tool)).allowed).toBe(true);
    expect(authorizer.authorize(request("visualize-turn", "visualize-extract")).allowed).toBe(
      false,
    );
    expect(authorizer.authorize(request("visualize-document", "turn-load")).allowed).toBe(false);
  });

  it("grants visualize-document its structure step and keeps it away from visualize-turn", () => {
    expect(authorizer.authorize(request("visualize-document", "visualize-structure")).allowed).toBe(
      true,
    );
    expect(authorizer.authorize(request("visualize-turn", "visualize-structure")).allowed).toBe(
      false,
    );
  });

  it("lets suggest-tags run its one step and nothing else", () => {
    expect(authorizer.authorize(request(SUGGEST_TAGS_FLOW_ID, "suggest-tags")).allowed).toBe(true);
    expect(authorizer.authorize(request(SUGGEST_TAGS_FLOW_ID, "ingest-summarize")).allowed).toBe(
      false,
    );
    expect(authorizer.authorize(request("ingest-document", "suggest-tags")).allowed).toBe(false);
  });

  it("lets chat-title run its one step and no chat tool", () => {
    expect(authorizer.authorize(request(CHAT_TITLE_FLOW_ID, "chat-title")).allowed).toBe(true);
    expect(authorizer.authorize(request(CHAT_TITLE_FLOW_ID, "search_docs")).allowed).toBe(false);
  });

  it("keeps ingest from calling a chat tool", () => {
    expect(authorizer.authorize(request("ingest-document", "search_docs")).allowed).toBe(false);
    expect(authorizer.authorize(request("ingest-document", "chat-model")).allowed).toBe(false);
  });
});
