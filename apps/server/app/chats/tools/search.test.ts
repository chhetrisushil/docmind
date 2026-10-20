import { isTainted, taintOf, unwrapTainted } from "@loom/classify";
import { describe, expect, it } from "vitest";
import { SearchUnavailableError } from "../retrieval";
import { ChatScopeError } from "../scope";
import { ChatToolInputError } from "./harness";
import { SearchInput, searchDocsTool, searchEffects } from "./search";
import { DOC_A, P1, P2, harness, passage, toolCtx, vectorScope } from "./testing";

function setup(
  results: ReturnType<typeof passage>[] | Error,
  scope: Parameters<typeof harness>[0] = "all",
) {
  const h = harness(scope);
  const calls: unknown[][] = [];
  const retriever = {
    async search(...args: unknown[]) {
      calls.push(args);
      if (results instanceof Error) throw results;
      return results;
    },
  };
  const { search_docs } = searchEffects({ ...h.deps, retriever: retriever as never });
  return { ...h, calls, run: (input: unknown, ctx = toolCtx()) => search_docs.execute(input, ctx) };
}

describe("search_docs", () => {
  it("searches as the call's own tenant and user, within the chat's scope, with k defaulting to 8", async () => {
    const scope = { documentIds: [DOC_A] };
    const s = setup([passage()], scope);
    await s.run({ query: "revenue forecast" });
    expect(s.calls).toEqual([[vectorScope, scope, "revenue forecast", 8, undefined]]);
  });

  it("passes k and trims the query", async () => {
    const s = setup([]);
    await s.run({ query: "  forecast  ", k: 12 });
    expect(s.calls[0]?.slice(2, 4)).toEqual(["forecast", 12]);
  });

  it("returns the passages as tainted document text with the fields the model cites", async () => {
    const s = setup([passage({ via: { kind: "entity", from: P2, entity: "Acme Ltd" } })]);
    const out = await s.run({ query: "q" });
    expect(isTainted(out)).toBe(true);
    expect(taintOf(out)?.origin).toBe("document");
    expect(unwrapTainted(out)).toEqual({
      passages: [
        {
          passageId: P1,
          documentId: DOC_A,
          document: "Nocturne planning memo",
          locator: { kind: "section", index: 2 },
          headingPath: ["Plan", "Q3"],
          text: "The revenue forecast is seventeen thousand dollars.",
          via: { kind: "entity", from: P2, entity: "Acme Ltd" },
        },
      ],
    });
  });

  it("stores the passages (a snippet, never the text) and the tool step before it returns, and publishes the step", async () => {
    const long = "x".repeat(400);
    const s = setup([passage({ text: long }), passage({ passageId: P2, text: "short" })]);
    await s.run({ query: "revenue\nforecast" });
    const stored = s.items.puts.map((p) => p.item);
    expect(stored[0]).toMatchObject({ kind: "passages" });
    const passages = (stored[0] as unknown as { body: { passages: Record<string, unknown>[] } })
      .body.passages;
    expect(passages.map((p) => Object.keys(p).sort())).toEqual([
      ["documentId", "headingPath", "locator", "passageId", "snippet"],
      ["documentId", "headingPath", "locator", "passageId", "snippet"],
    ]);
    expect((passages[0]?.snippet as string).length).toBeLessThanOrEqual(280);
    expect(passages[1]?.snippet).toBe("short");
    const step = { name: "search_docs", label: 'Searched documents: "revenue forecast"', count: 2 };
    expect(stored[1]).toEqual({ kind: "tool", body: step });
    expect(
      s.items.puts.every((p) => p.turnKey === 3 && p.stepKey === "conv#o3#turn:1:tool:0"),
    ).toBe(true);
    expect(s.events).toEqual([{ kind: "tool", turnKey: 3, step }]);
  });

  it("clips a long query in the label", async () => {
    const s = setup([]);
    await s.run({ query: "w".repeat(500) });
    const label = (s.items.puts[0]?.item as { body: { label: string } }).body.label;
    expect([...label].length).toBeLessThanOrEqual(120);
  });

  it("answers search_unavailable when the embedder is down, records a step with count 0, and stores no passages", async () => {
    const s = setup(new SearchUnavailableError());
    const out = await s.run({ query: "q" });
    expect(unwrapTainted(out)).toEqual({ error: "search_unavailable" });
    expect(s.items.puts.map((p) => p.item.kind)).toEqual(["tool"]);
    expect(s.events).toHaveLength(1);
  });

  it("turns any other failure into a fixed class-only error that carries none of its message", async () => {
    const s = setup(new RangeError("boom with the query text"));
    await expect(s.run({ query: "q" })).rejects.toThrow(/^chat tool failed: RangeError$/);
    expect(s.items.puts).toEqual([]);
  });

  it.each([
    ["a missing query", {}],
    ["a blank query", { query: "   " }],
    ["a 501-character query", { query: "x".repeat(501) }],
    ["a non-string query", { query: 5 }],
    ["k below 1", { query: "q", k: 0 }],
    ["k above 12", { query: "q", k: 13 }],
    ["a fractional k", { query: "q", k: 1.5 }],
    ["a forged tenant", { query: "q", tenantId: "other" }],
    ["a forged scope", { query: "q", scope: "all" }],
    ["not an object", "q"],
  ])("refuses %s and does nothing", async (_name, input) => {
    const s = setup([passage()]);
    await expect(s.run(input)).rejects.toBeInstanceOf(ChatToolInputError);
    expect([s.calls.length, s.items.puts.length, s.events.length]).toEqual([0, 0, 0]);
  });

  it("refuses a call whose chat is gone, or that is not the owner's, before searching", async () => {
    const gone = setup([passage()], null);
    await expect(gone.run({ query: "q" })).rejects.toBeInstanceOf(ChatScopeError);
    const foreign = setup([passage()]);
    const ctx = toolCtx({
      principal: { tenant: vectorScope.tenantId, actor: "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1" },
    });
    await expect(foreign.run({ query: "q" }, ctx)).rejects.toBeInstanceOf(ChatScopeError);
    expect([gone.calls.length, foreign.calls.length]).toEqual([0, 0]);
  });
});

describe("the search_docs definition", () => {
  it("is a read-only, idempotent tool whose id is its name, with a strict schema", () => {
    expect([searchDocsTool.id, searchDocsTool.name, searchDocsTool.idempotent]).toEqual([
      "search_docs",
      "search_docs",
      true,
    ]);
    expect(SearchInput.safeParse({ query: "q", extra: 1 }).success).toBe(false);
  });
});
