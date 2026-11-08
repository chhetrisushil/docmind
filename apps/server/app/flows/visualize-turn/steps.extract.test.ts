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
function setup(
  o: {
    llm?: LlmProvider;
    retrieved?: string[];
    summaryMaxChars?: number;
    existing?: Fact[];
    noTurn?: boolean;
  } = {},
) {
  const writes: Fact[][] = [];
  const read = vi.fn(
    async (_s: unknown, ids: readonly string[]) =>
      new Map(ids.filter((i) => TEXTS[i]).map((i) => [i, { text: TEXTS[i] as string }])),
  );
  const effect = turnExtractEffect({
    guard: { begin: async () => {} },
    turn: {
      read: async () =>
        o.noTurn
          ? null
          : { status: "complete", retrieved: o.retrieved ?? [K0, GONE, K1], citations: [] },
    },
    passages: { read: read as never },
    facts: {
      replace: async (_r, facts) => {
        writes.push([...facts]);
        return facts.length;
      },
      list: async () => o.existing ?? [],
    },
    summaryMaxChars: o.summaryMaxChars ?? 400_000,
    sleep: async () => {},
    ...(o.llm && { llm: o.llm }),
  });
  return {
    effect,
    writes,
    read,
    run: (signal?: AbortSignal) =>
      effect.execute(ref, { executionId: "e", ...(signal && { signal }) } as never),
  };
}

describe("turn-extract", () => {
  it("does nothing for a turn that already has facts (a re-run): no model call, no write", async () => {
    const llm = llmReplying([GOOD]);
    const fact: Fact = { kind: "figure", label: "L", value: 1, chunkIds: [K0], ordinal: 0 };
    const s = setup({ llm, existing: [fact] });
    expect(await s.run()).toEqual({ outcome: "done", count: 1, model: "visuals-test" });
    expect(llm.calls).toHaveLength(0);
    expect(s.writes).toHaveLength(0);
  });

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
  it("clears the turn's facts (count 0, no model call) when the turn cannot be read, and when it retrieved nothing", async () => {
    for (const o of [{ noTurn: true }, { retrieved: [] as string[] }, { retrieved: [GONE] }]) {
      const llm = llmReplying([GOOD]);
      const s = setup({ llm, ...o });
      expect(await s.run()).toEqual({ outcome: "done", count: 0, model: "visuals-test" });
      expect(s.writes).toEqual([[]]);
      expect(llm.calls).toHaveLength(0);
    }
  });
  it("treats a truncated answer (max_tokens) as a failure, not as facts: it throws and stores nothing", async () => {
    const llm = {
      model: "m",
      complete: async () => ({ content: '{"facts":[', stopReason: "max_tokens" }),
    } as never;
    const s = setup({ llm });
    await expect(s.run()).rejects.toThrow();
    expect(s.writes).toEqual([]);
  });
  it("forwards the attempt's abort signal to the model", async () => {
    const llm = llmReplying([GOOD]);
    const ac = new AbortController();
    await setup({ llm }).run(ac.signal);
    const seen = (llm.calls[0] as { signal?: AbortSignal }).signal;
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
    ac.abort(); // the model's signal follows the attempt's
    expect(seen?.aborted).toBe(true);
  });
  it("is done with model 'none' and calls nothing when the visuals role is off", async () => {
    const s = setup();
    expect(await s.run()).toEqual({ outcome: "done", model: "none" });
    expect(s.read).not.toHaveBeenCalled();
  });
});
