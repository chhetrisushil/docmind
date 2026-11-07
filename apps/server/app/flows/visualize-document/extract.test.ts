import { randomUUID } from "node:crypto";
import { LlmRefusalError } from "@docmind/llm-anthropic";
import { tainted } from "@loom/classify";
import { type LlmProvider, type LlmRequest, guardRequest } from "@loom/llm";
import { describe, expect, it, vi } from "vitest";
import { LLM_RETRY } from "../ingest-document/stepEffect";
import { EXTRACT_WINDOW_CHARS, extractEffect } from "./extract";
import type { Fact } from "./facts";
import type { VisualizeRef } from "./pgFacts";

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
    list: async () => [] as Fact[],
  };
  const d = {
    guard: { begin: async () => {} },
    chunks: {
      sectionsOf: async () => Object.keys(texts).map((id) => ({ id, sectionOrdinal: 0 })),
      read: async (_r: unknown, ids: string[]) => ids.map((id) => ({ id, text: texts[id] ?? "" })),
    },
    facts: store,
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
});
