import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DocumentGoneError } from "../ingest-document/errors";
import type { Fact } from "../visualize-document/facts";
import { turnLoadEffect } from "./steps";

const ref = { tenantId: randomUUID(), userId: randomUUID(), chatId: randomUUID(), ord: 4 };
const A = randomUUID();
const B = randomUUID();
const K1 = randomUUID();
const K2 = randomUUID();
const fig = (ordinal: number, chunk: string): Fact => ({
  kind: "figure",
  label: "Revenue",
  value: 1,
  chunkIds: [chunk],
  ordinal,
});
const guard = { begin: vi.fn(async () => {}) };
const run = (turn: unknown, lists: Record<string, Fact[] | "gone">) =>
  turnLoadEffect({
    guard,
    turn: { read: vi.fn(async () => turn) } as never,
    facts: {
      list: vi.fn(async (r: { documentId: string }) => {
        const v = lists[r.documentId];
        if (v === "gone") throw new DocumentGoneError();
        return v ?? [];
      }),
      replace: vi.fn(),
    },
  }).execute(ref, { executionId: "e" } as never);

describe("turn-load", () => {
  it("outputs references only, for stored facts that cover the citations", async () => {
    const out = await run(
      {
        status: "complete",
        retrieved: [K1, K2],
        citations: [
          { passageId: K1, documentId: A },
          { passageId: K2, documentId: B },
        ],
      },
      { [A]: [fig(0, K1), fig(1, randomUUID())], [B]: "gone" },
    );
    expect(out).toEqual({ outcome: "done", cited: true, refs: [{ documentId: A, ordinal: 0 }] });
    expect(JSON.stringify(out)).not.toContain("Revenue");
  });
  it("reports cited with no references when nothing covers (the flow then extracts)", async () => {
    const out = await run(
      { status: "complete", retrieved: [K1], citations: [{ passageId: K1, documentId: A }] },
      { [A]: [fig(0, randomUUID())] },
    );
    expect(out).toEqual({ outcome: "done", cited: true, refs: [] });
  });
  it("is not cited for an uncited, interrupted or missing turn", async () => {
    for (const turn of [
      { status: "complete", retrieved: [K1], citations: [] },
      { status: "interrupted", retrieved: [K1], citations: [{ passageId: K1, documentId: A }] },
      null,
    ])
      expect(await run(turn, {})).toEqual({ outcome: "done", cited: false, refs: [] });
  });
  it("ends as document_gone when the guard says the chat is gone", async () => {
    guard.begin.mockRejectedValueOnce(new DocumentGoneError());
    expect(await run({ status: "complete", retrieved: [], citations: [] }, {})).toEqual({
      outcome: "document_gone",
      cited: false,
      refs: [],
    });
  });
});
