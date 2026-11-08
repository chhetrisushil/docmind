import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DocumentGoneError } from "../ingest-document/errors";
import type { Fact } from "../visualize-document/facts";
import { turnFactsEffect } from "./steps";

const ref = { tenantId: randomUUID(), userId: randomUUID(), chatId: randomUUID(), ord: 4 };
const A = randomUUID();
const B = randomUUID();
const fig = (ordinal: number, label: string): Fact => ({
  kind: "figure",
  label,
  value: 1,
  chunkIds: [randomUUID()],
  ordinal,
});
const guard = { begin: async () => {} };

describe("turn-facts", () => {
  it("reads each referenced document once and picks the referenced ordinals, in reference order", async () => {
    const list = vi.fn(async (r: { documentId: string }) =>
      r.documentId === A ? [fig(0, "a0"), fig(1, "a1"), fig(2, "a2")] : [fig(0, "b0")],
    );
    const out = await turnFactsEffect({
      guard,
      stored: { list, replace: vi.fn() },
      turnFacts: { list: vi.fn(), replace: vi.fn() },
    }).execute(
      {
        ...ref,
        refs: [
          { documentId: A, ordinal: 2 },
          { documentId: B, ordinal: 0 },
          { documentId: A, ordinal: 0 },
        ],
      },
      { executionId: "e" } as never,
    );
    expect(list).toHaveBeenCalledTimes(2);
    expect(out.facts.map((f) => [f.origin, (f.fact as { label: string }).label])).toEqual([
      [{ kind: "doc", documentId: A }, "a2"],
      [{ kind: "doc", documentId: B }, "b0"],
      [{ kind: "doc", documentId: A }, "a0"],
    ]);
  });
  it("drops a reference whose document is gone or whose fact was replaced since", async () => {
    const list = vi.fn(async (r: { documentId: string }) => {
      if (r.documentId === B) throw new DocumentGoneError();
      return [fig(0, "a0")];
    });
    const out = await turnFactsEffect({
      guard,
      stored: { list, replace: vi.fn() },
      turnFacts: { list: vi.fn(), replace: vi.fn() },
    }).execute(
      {
        ...ref,
        refs: [
          { documentId: A, ordinal: 0 },
          { documentId: A, ordinal: 9 },
          { documentId: B, ordinal: 0 },
        ],
      },
      { executionId: "e" } as never,
    );
    expect(out.facts).toHaveLength(1);
  });
  it("rethrows an error that is not 'the document is gone'", async () => {
    const list = vi.fn(async () => {
      throw new TypeError("db down");
    });
    const run = turnFactsEffect({
      guard,
      stored: { list, replace: vi.fn() },
      turnFacts: { list: vi.fn(), replace: vi.fn() },
      sleep: async () => {},
    }).execute({ ...ref, refs: [{ documentId: A, ordinal: 0 }] }, { executionId: "e" } as never);
    await expect(run).rejects.toThrow();
  });
  it("reads the turn's own facts when there are no references", async () => {
    const turnList = vi.fn(async () => [fig(0, "t0"), fig(1, "t1")]);
    const out = await turnFactsEffect({
      guard,
      stored: { list: vi.fn(), replace: vi.fn() },
      turnFacts: { list: turnList, replace: vi.fn() },
    }).execute({ ...ref, refs: [] }, { executionId: "e" } as never);
    expect(out.facts.map((f) => f.origin)).toEqual([{ kind: "turn" }, { kind: "turn" }]);
  });
});
