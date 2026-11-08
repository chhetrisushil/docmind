import { randomUUID } from "node:crypto";
import { LlmRefusalError } from "@docmind/llm-anthropic";
import type { LlmProvider } from "@loom/llm";
import { describe, expect, it, vi } from "vitest";
import type { Fact } from "../visualize-document/facts";
import type { TurnRef } from "./ids";
import { turnExtractEffect } from "./steps";

const K0 = randomUUID();
const K1 = randomUUID();
const GONE = randomUUID();
const TEXTS: Record<string, string> = {
  [K0]: "Revenue was 120 in 2023 and 150 in 2024.",
  [K1]: "Headcount reached 300.",
};
const GOOD = {
  kind: "series",
  label: "Revenue",
  points: [
    { x: "2023", y: 120 },
    { x: "2024", y: 150 },
  ],
  chunkIds: [K0],
};
const BAD = { kind: "figure", label: "Headcount", value: 999, chunkIds: [K1] };
const ref: TurnRef = { tenantId: randomUUID(), userId: randomUUID(), chatId: randomUUID(), ord: 4 };

const llmReplying = (facts: unknown[]): LlmProvider & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    model: "visuals-test",
    complete: async (req: unknown) => {
      calls.push(req);
      return { content: JSON.stringify({ facts }), stopReason: "end_turn" };
    },
  } as never;
};
function setup(o: { llm?: LlmProvider; retrieved?: string[]; summaryMaxChars?: number } = {}) {
  const writes: Fact[][] = [];
  const read = vi.fn(
    async (_s: unknown, ids: readonly string[]) =>
      new Map(ids.filter((i) => TEXTS[i]).map((i) => [i, { text: TEXTS[i] as string }])),
  );
  const effect = turnExtractEffect({
    guard: { begin: async () => {} },
    turn: {
      read: async () => ({
        status: "complete",
        retrieved: o.retrieved ?? [K0, GONE, K1],
        citations: [],
      }),
    },
    passages: { read: read as never },
    facts: {
      replace: async (_r, facts) => {
        writes.push([...facts]);
        return facts.length;
      },
      list: async () => [],
    },
    summaryMaxChars: o.summaryMaxChars ?? 400_000,
    ...(o.llm && { llm: o.llm }),
  });
  return { effect, writes, read, run: () => effect.execute(ref, { executionId: "e" } as never) };
}

describe("turn-extract", () => {
  it("grounds the model's facts against the retrieved chunks, drops the ungrounded, and stores the rest", async () => {
    const llm = llmReplying([GOOD, BAD]);
    const s = setup({ llm });
    expect(await s.run()).toEqual({ outcome: "done", count: 1, model: "visuals-test" });
    expect(s.writes).toHaveLength(1);
    expect(s.writes[0]?.map((f) => [f.kind, f.ordinal])).toEqual([["series", 0]]);
    expect(s.read).toHaveBeenCalledWith({ tenantId: ref.tenantId, ownerId: ref.userId }, [
      K0,
      GONE,
      K1,
    ]);
  });
  it("drops the chunks of a document deleted since (they are absent from the read)", async () => {
    const llm = llmReplying([GOOD]);
    await setup({ llm, retrieved: [K0, GONE] }).run();
    expect(JSON.stringify(llm.calls)).not.toContain(GONE);
  });
  it("cites chunks outside the retrieved set as ungrounded", async () => {
    const s = setup({ llm: llmReplying([{ ...GOOD, chunkIds: [GONE] }]) });
    expect((await s.run()).count).toBe(0);
    expect(s.writes[0]).toEqual([]);
  });
  it("stops reading chunks once the cap is reached", async () => {
    const llm = llmReplying([]);
    await setup({ llm, summaryMaxChars: 10 }).run();
    expect(JSON.stringify(llm.calls)).toContain(K0);
    expect(JSON.stringify(llm.calls)).not.toContain(K1);
  });
  it("clears the turn's facts on a refusal and is done with none", async () => {
    const llm = {
      model: "m",
      complete: async () => {
        throw new LlmRefusalError();
      },
    } as never;
    const s = setup({ llm });
    expect(await s.run()).toEqual({ outcome: "done", count: 0, model: "m" });
    expect(s.writes).toEqual([[]]);
  });
  it("is done with model 'none' and calls nothing when the visuals role is off", async () => {
    const s = setup();
    expect(await s.run()).toEqual({ outcome: "done", model: "none" });
    expect(s.read).not.toHaveBeenCalled();
  });
});
