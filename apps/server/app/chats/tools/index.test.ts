import { describe, expect, it } from "vitest";
import { CHAT_TOOL_IDS } from "../ids";
import { CHAT_TOOL_DEFS, chatTools } from "./index";
import { harness } from "./testing";

describe("the chat tool set", () => {
  it("defines exactly the five granted tool ids, each with its id as its name, all read-only and idempotent", () => {
    expect(CHAT_TOOL_DEFS.map((t) => t.id)).toEqual([...CHAT_TOOL_IDS]);
    for (const t of CHAT_TOOL_DEFS)
      expect([t.name, t.idempotent, t.kind]).toEqual([t.id, true, "tool"]);
  });

  it("registers one idempotent tool effect per definition and nothing else", () => {
    const h = harness();
    const effects = chatTools({
      ...h.deps,
      retriever: {} as never,
      passages: {} as never,
      documents: {} as never,
    });
    expect(Object.keys(effects).sort()).toEqual([...CHAT_TOOL_IDS].sort());
    for (const e of Object.values(effects)) expect([e.kind, e.idempotent]).toEqual(["tool", true]);
  });
});
