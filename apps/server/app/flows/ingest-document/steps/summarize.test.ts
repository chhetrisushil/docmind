import { randomUUID } from "node:crypto";
import { LlmRefusalError, LlmRequestError, LlmUnavailableError } from "@docmind/llm-anthropic";
import type { ParsedDocument } from "@docmind/parsers";
import type { LlmProvider, LlmRequest } from "@loom/llm";
import { describe, expect, it, vi } from "vitest";
import { bounded } from "../../../llm/bounded";
import type { IngestStartInput } from "../flow";
import type { EntityMention } from "../pgEntities";
import { LLM_RETRY } from "../stepEffect";
import { fakeResults } from "../testing";
import { summarizeEffect } from "./summarize";

const C0 = randomUUID();
const C1 = randomUUID();
const C2 = randomUUID();
const PARSED: ParsedDocument = {
  text: "one\n\ntwo",
  sections: ["one", "two"].map((text, i) => ({
    headingPath: [],
    text,
    locator: { kind: "chars" as const, start: i, end: i + 3 },
  })),
  media: [],
};
const REDUCE = JSON.stringify({
  tldr: "T",
  keyPoints: ["k"],
  entities: ["Acme"],
  topics: ["t"],
  suggestedQuestions: ["q?"],
});
const MAP = JSON.stringify({ summary: "s", entities: [{ name: "Acme", kind: "organization" }] });

function scripted() {
  const state = { calls: 0 };
  const provider: LlmProvider & { model: string } = {
    model: "claude-test",
    complete: async (r: LlmRequest) => {
      state.calls++;
      const reduce = (r.system ?? "").startsWith("You combine");
      return { content: reduce ? REDUCE : MAP, stopReason: "end_turn" };
    },
  };
  return { provider, state };
}

const SOME_SUMMARY = {
  tldr: "x",
  keyPoints: [],
  entities: [],
  topics: [],
  suggestedQuestions: [],
};

function deps(
  over: {
    llm?: LlmProvider;
    summary?: boolean;
    onWrite?: (w: string) => void;
    sleep?: () => Promise<void>;
  } = {},
) {
  const results = fakeResults();
  const ref: IngestStartInput = {
    tenantId: randomUUID(),
    userId: randomUUID(),
    documentId: randomUUID(),
  };
  if (over.summary) results.summaries.set(ref.documentId, SOME_SUMMARY);
  const putSummary = results.putSummary;
  results.putSummary = async (...a) => {
    over.onWrite?.("summary");
    return putSummary(...a);
  };
  const entities = {
    lastMentions: [] as EntityMention[],
    replaceForDocument: async (_r: IngestStartInput, m: EntityMention[]) => {
      over.onWrite?.("entities");
      entities.lastMentions = m;
      return m.length;
    },
    sharedWith: async () => [],
  };
  return {
    ref,
    results,
    entities,
    d: {
      guard: { begin: async () => {} },
      parsed: {
        put: async () => {},
        take: async () => PARSED,
        has: async () => true,
        drop: async () => {},
      },
      chunks: {
        replace: async () => 0,
        count: async () => 3,
        read: async () => [],
        sectionsOf: async () => [
          { id: C0, sectionOrdinal: 0 },
          { id: C1, sectionOrdinal: 0 },
          { id: C2, sectionOrdinal: 1 },
        ],
      },
      results,
      entities,
      ...(over.llm && { llm: over.llm }),
      summaryMaxChars: 1_000,
      sleep: over.sleep ?? (async () => {}),
    },
  };
}
const run = (s: ReturnType<typeof deps>) => summarizeEffect(s.d).execute(s.ref, {} as never);
const withModel = (complete: LlmProvider["complete"]): LlmProvider =>
  Object.assign({ complete }, { model: "claude-test" });

describe("summarize step: model id through bounded", () => {
  it.each(["gemma4:31b-cloud", "gemini-3.5-flash"])("records %s", async (model) => {
    const inner = Object.assign(scripted().provider, { model });
    const llm = bounded(inner, { maxTokens: 2048, timeoutMs: 5_000 });
    expect(await run(deps({ llm }))).toMatchObject({ outcome: "done", model });
  });
});

describe("summarize step", () => {
  it("skips without a provider and stores nothing", async () => {
    const s = deps();
    expect(await run(s)).toEqual({ outcome: "done", model: "none" });
    expect(await s.results.hasSummary(s.ref)).toBe(false);
    expect(s.entities.lastMentions).toEqual([]);
  });

  it("stores the entity mentions of each group's chunks, then the summary", async () => {
    const order: string[] = [];
    const s = deps({ llm: scripted().provider, onWrite: (w) => order.push(w) });
    // one group per section is not forced by size, so both sections may share a group: accept either packing
    const out = await run(s);
    expect(out).toMatchObject({ outcome: "done", model: "claude-test" });
    expect(s.entities.lastMentions.flatMap((m) => m.chunkIds).sort()).toEqual([C0, C1, C2].sort());
    expect(s.entities.lastMentions.every((m) => m.name === "Acme")).toBe(true);
    expect(order).toEqual(["entities", "summary"]);
    expect(await s.results.hasSummary(s.ref)).toBe(true);
  });

  it("skips when a summary already exists (a retry after a later step failed)", async () => {
    const t = scripted();
    const s = deps({ llm: t.provider, summary: true });
    expect(await run(s)).toEqual({ outcome: "done", count: 0, model: "claude-test" });
    expect(t.state.calls).toBe(0);
  });

  it("a refusal leaves the document without a summary but does not fail it", async () => {
    const s = deps({
      llm: withModel(async () => {
        throw new LlmRefusalError();
      }),
    });
    expect(await run(s)).toEqual({ outcome: "done", count: 0, model: "claude-test" });
    expect(await s.results.hasSummary(s.ref)).toBe(false);
  });

  it("retries an outage and fails a rejected request with the fixed message", async () => {
    const ok = scripted().provider;
    let calls = 0;
    const once = withModel(async (r) => {
      if (calls++ === 0) throw new LlmUnavailableError(529);
      return ok.complete(r);
    });
    expect((await run(deps({ llm: once }))).outcome).toBe("done");
    const denied = withModel(async () => {
      throw new LlmRequestError(401);
    });
    await expect(run(deps({ llm: denied }))).rejects.toThrow(/^ingest step failed: summarize$/);
  });
});

describe("summarize step: LLM_RETRY", () => {
  it("retries a Claude outage LLM_RETRY.maxAttempts attempts in all, then fails with the fixed message", async () => {
    const down = withModel(async () => {
      throw new LlmUnavailableError(529);
    });
    const sleep = vi.fn(async () => {});
    await expect(run(deps({ llm: down, sleep }))).rejects.toThrow(
      /^ingest step failed: summarize$/,
    );
    expect(sleep).toHaveBeenCalledTimes(LLM_RETRY.maxAttempts - 1);
  });
});
