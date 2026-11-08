import { randomUUID } from "node:crypto";
import { LlmRefusalError, LlmRequestError, LlmUnavailableError } from "@docmind/llm-anthropic";
import { tainted } from "@loom/classify";
import { type LlmProvider, type LlmRequest, guardRequest } from "@loom/llm";
import { describe, expect, it, vi } from "vitest";
import { LLM_RETRY } from "../ingest-document/stepEffect";
import { EXTRACT_WINDOW_CHARS, extractEffect } from "./extract";
import type { Fact } from "./facts";
import type { VisualizeRef } from "./pgFacts";
import { visualizeExecutionId } from "./start";

const C0 = randomUUID();
const C1 = randomUUID();
const TEXTS: Record<string, string> = {
  [C0]: "Revenue was 120 in 2023 and 150 in 2024.",
  [C1]: "Headcount reached 300.",
};

const GOOD = {
  kind: "series",
  label: "Revenue",
  points: [
    { x: "2023", y: 120 },
    { x: "2024", y: 150 },
  ],
  chunkIds: [C0],
};
const BAD = { kind: "figure", label: "Headcount", value: 999, chunkIds: [C1] };

function setup(
  over: {
    llm?: LlmProvider;
    texts?: Record<string, string>;
    summaryMaxChars?: number;
    sleep?: () => Promise<void>;
  } = {},
) {
  const texts = over.texts ?? TEXTS;
  const ref: VisualizeRef = {
    tenantId: randomUUID(),
    userId: randomUUID(),
    documentId: randomUUID(),
  };
  const store = {
    writes: [] as Fact[][],
    held: [] as Fact[],
    replace: async (_r: VisualizeRef, facts: readonly Fact[]) => {
      store.writes.push([...facts]);
      store.held = [...facts];
      return facts.length;
    },
    list: async () => store.held,
  };
  const d = {
    guard: { begin: async () => {} },
    chunks: {
      sectionsOf: async () => Object.keys(texts).map((id) => ({ id, sectionOrdinal: 0 })),
      read: async (_r: unknown, ids: string[]) => ids.map((id) => ({ id, text: texts[id] ?? "" })),
    },
    facts: store,
    summaryMaxChars: over.summaryMaxChars ?? 400_000,
    sleep: over.sleep ?? (async () => {}),
    ...(over.llm && { llm: over.llm }),
  };
  return { ref, store, d };
}
const run = (s: ReturnType<typeof setup>) => extractEffect(s.d).execute(s.ref, {} as never);
const scripted = (answer: (r: LlmRequest) => string) => {
  const requests: LlmRequest[] = [];
  const llm: LlmProvider & { model: string } = {
    model: "claude-test",
    complete: async (r: LlmRequest) => {
      requests.push(r);
      return { content: answer(r), stopReason: "end_turn" };
    },
  };
  return { llm, requests };
};

describe("visualize-extract step", () => {
  it("stores the grounded fact and drops the ungrounded one", async () => {
    const { llm } = scripted(() => JSON.stringify({ facts: [GOOD, BAD] }));
    const s = setup({ llm });
    expect(await run(s)).toEqual({ outcome: "done", count: 1, model: "claude-test" });
    expect(s.store.writes).toHaveLength(1);
    expect(s.store.writes[0]?.map((f) => f.ordinal)).toEqual([0]);
    expect(s.store.writes[0]?.[0]?.kind).toBe("series");
  });

  it("is done with model none and no write without a provider", async () => {
    const s = setup();
    expect(await run(s)).toEqual({ outcome: "done", model: "none" });
    expect(s.store.writes).toEqual([]);
  });

  it("retries invalid JSON LLM_RETRY.maxAttempts times, then fails with the fixed message", async () => {
    const { llm } = scripted(() => "not json");
    const sleep = vi.fn(async () => {});
    const s = setup({ llm, sleep });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(run(s)).rejects.toThrow(/^ingest step failed: visualize-extract$/);
    expect(sleep).toHaveBeenCalledTimes(LLM_RETRY.maxAttempts - 1);
    expect(s.store.writes).toEqual([]);
  });

  it("a refusal clears facts a previous run stored, and is not a failure", async () => {
    const llm = Object.assign(
      {
        complete: async () => {
          throw new LlmRefusalError();
        },
      },
      { model: "claude-test" },
    );
    const s = setup({ llm });
    s.store.held = [{ ...GOOD, ordinal: 0 } as Fact];
    expect(await run(s)).toEqual({ outcome: "done", count: 0, model: "claude-test" });
    expect(s.store.held).toEqual([]);
  });

  it("windows 3 chunks of 10,000 characters into 2 calls without splitting a chunk", async () => {
    expect(EXTRACT_WINDOW_CHARS).toBe(24_000);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const texts = Object.fromEntries(ids.map((id) => [id, "x".repeat(10_000)]));
    const { llm, requests } = scripted(() => '{"facts":[]}');
    const s = setup({ llm, texts });
    expect(await run(s)).toMatchObject({ outcome: "done", count: 0 });
    expect(requests).toHaveLength(2);
    const sent = requests.map((r) => ids.filter((id) => JSON.stringify(r).includes(`[[${id}]]`)));
    expect(sent).toEqual([[ids[0], ids[1]], [ids[2]]]);
  });

  it("reads at most the summary cap of chunk text, in order: later chunks make no window", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const texts = Object.fromEntries(ids.map((id) => [id, "x".repeat(10_000)]));
    const { llm, requests } = scripted(() => '{"facts":[]}');
    const s = setup({ llm, texts, summaryMaxChars: 20_000 });
    await run(s);
    expect(requests).toHaveLength(1);
    const sent = ids.filter((id) => JSON.stringify(requests[0]).includes(`[[${id}]]`));
    expect(sent).toEqual([ids[0], ids[1]]);
  });

  it("logs the dropped-fact count as a number only", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { llm } = scripted(() => JSON.stringify({ facts: [GOOD, BAD] }));
    await run(setup({ llm }));
    expect(info).toHaveBeenCalledWith("visualize-extract dropped ungrounded facts", 1);
    info.mockRestore();
  });

  it("fences the chunk text as untrusted document data", async () => {
    const { llm, requests } = scripted(() => '{"facts":[]}');
    await run(setup({ llm }));
    const [req] = requests;
    const text = `[[${C0}]]\n${TEXTS[C0]}\n\n[[${C1}]]\n${TEXTS[C1]}`;
    const content = req?.messages[0]?.content as { type: string; text: string }[];
    const fenced = guardRequest({
      messages: [{ role: "user", content: [{ type: "text", text: tainted(text, "document") }] }],
    });
    expect(content[0]?.text).toBe((fenced.messages[0]?.content as { text: string }[])[0]?.text);
    expect(content[0]?.text).toMatch(/^<untrusted-input origin="document">/);
    expect(req?.system).toContain("untrusted");
  });

  const failing = (err: () => Error) => {
    const calls = { n: 0 };
    const llm = Object.assign(
      {
        complete: async () => {
          calls.n++;
          throw err();
        },
      },
      { model: "claude-test" },
    );
    return { llm, calls };
  };

  it("ends failed with visuals-model-unavailable when the model stays unavailable through every attempt", async () => {
    const { llm, calls } = failing(() => new LlmUnavailableError(503));
    const sleep = vi.fn(async () => {});
    const s = setup({ llm, sleep });
    expect(await run(s)).toEqual({ outcome: "failed", code: "visuals-model-unavailable" });
    expect(calls.n).toBe(LLM_RETRY.maxAttempts);
    expect(sleep).toHaveBeenCalledTimes(LLM_RETRY.maxAttempts - 1);
    expect(s.store.writes).toEqual([]);
  });

  it("an unavailable model that comes back within the attempts is a normal run", async () => {
    let n = 0;
    const llm = Object.assign(
      {
        complete: async () => {
          if (++n < 3) throw new LlmUnavailableError(529);
          return { content: JSON.stringify({ facts: [GOOD] }), stopReason: "end_turn" as const };
        },
      },
      { model: "claude-test" },
    );
    expect(await run(setup({ llm }))).toEqual({ outcome: "done", count: 1, model: "claude-test" });
  });

  it("a permanent model error and bad JSON are not 'unavailable': the step still fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { llm } = failing(() => new LlmRequestError(400));
    await expect(run(setup({ llm }))).rejects.toThrow(/^ingest step failed: visualize-extract$/);
  });

  describe("a re-run (-r<n> execution)", () => {
    const rerunCtx = (s: ReturnType<typeof setup>, n = 1) =>
      ({ executionId: visualizeExecutionId(s.ref.userId, s.ref.documentId, 1, n) }) as never;

    it("keeps the stored facts and makes no model call", async () => {
      const { llm, requests } = scripted(() => JSON.stringify({ facts: [GOOD] }));
      const s = setup({ llm });
      s.store.held = [{ ...GOOD, ordinal: 0 } as Fact, { ...GOOD, ordinal: 1 } as Fact];
      expect(await extractEffect(s.d).execute(s.ref, rerunCtx(s))).toEqual({
        outcome: "done",
        count: 2,
        model: "claude-test",
      });
      expect(requests).toEqual([]);
      expect(s.store.writes).toEqual([]);
    });

    it("extracts when the document has no stored facts", async () => {
      const { llm, requests } = scripted(() => JSON.stringify({ facts: [GOOD] }));
      const s = setup({ llm });
      expect(await extractEffect(s.d).execute(s.ref, rerunCtx(s, 4))).toMatchObject({
        outcome: "done",
        count: 1,
      });
      expect(requests).toHaveLength(1);
    });

    const lastOf = (state: "done" | "failed", run = 0) => ({
      last: async () => ({ run, state, code: null }),
    });

    it("a zero-fact document whose last run was done re-plans with no extraction (count 0)", async () => {
      const { llm, requests } = scripted(() => JSON.stringify({ facts: [GOOD] }));
      const s = setup({ llm });
      const d = { ...s.d, runs: lastOf("done") };
      expect(await extractEffect(d).execute(s.ref, rerunCtx(s))).toEqual({
        outcome: "done",
        count: 0,
        model: "claude-test",
      });
      expect(requests).toEqual([]);
      expect(s.store.writes).toEqual([]);
    });

    it("a re-run the starter noted as after a done run skips extraction even when its own record replaced the state", async () => {
      const { llm, requests } = scripted(() => JSON.stringify({ facts: [GOOD] }));
      const s = setup({ llm });
      const ctx = rerunCtx(s, 2);
      const afterDone = new Set([(ctx as { executionId: string }).executionId]);
      const d = {
        ...s.d,
        runs: { last: async () => ({ run: 2, state: "running" as const, code: null }) },
        afterDone,
      };
      expect(await extractEffect(d).execute(s.ref, ctx)).toMatchObject({ count: 0 });
      expect(requests).toEqual([]);
    });

    it("a zero-fact document whose last run failed (or never ran) extracts", async () => {
      const { llm, requests } = scripted(() => JSON.stringify({ facts: [GOOD] }));
      const s = setup({ llm });
      expect(
        await extractEffect({ ...s.d, runs: lastOf("failed") }).execute(s.ref, rerunCtx(s)),
      ).toMatchObject({ count: 1 });
      expect(requests).toHaveLength(1);
    });

    it("the automatic run (no -r) extracts again over stored facts", async () => {
      const { llm, requests } = scripted(() => JSON.stringify({ facts: [GOOD] }));
      const s = setup({ llm });
      s.store.held = [{ ...GOOD, ordinal: 0 } as Fact];
      const ctx = { executionId: visualizeExecutionId(s.ref.userId, s.ref.documentId, 1) } as never;
      await extractEffect(s.d).execute(s.ref, ctx);
      expect(requests).toHaveLength(1);
    });

    it("with the role off a re-run is still model none", async () => {
      const s = setup();
      expect(await extractEffect(s.d).execute(s.ref, rerunCtx(s))).toEqual({
        outcome: "done",
        model: "none",
      });
    });
  });
});
