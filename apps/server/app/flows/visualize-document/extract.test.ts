import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LlmRefusalError, LlmRequestError, LlmUnavailableError } from "@docmind/llm-anthropic";
import { tainted } from "@loom/classify";
import {
  type LlmProvider,
  type LlmRequest,
  UNTRUSTED_CONTENT_SYSTEM_NOTE,
  guardRequest,
} from "@loom/llm";
import { describe, expect, it, vi } from "vitest";
import { LLM_RETRY } from "../ingest-document/stepEffect";
import { EXTRACT_WINDOW_CHARS, askForExtraction, askForFacts, extractEffect } from "./extract";
import { EXTRACT_FORMAT, type ExtractionWrite, type Fact } from "./facts";
import type { VisualizeRef } from "./pgFacts";
import { EXTRACT_DOCUMENT_SYSTEM, EXTRACT_SYSTEM, extractDocumentSystem } from "./prompts";
import { visualizeExecutionId } from "./start";
import { aggregateFacts } from "./testing";

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
    writes: [] as ExtractionWrite[][],
    held: [] as ExtractionWrite[],
    replace: async (_r: VisualizeRef, facts: readonly ExtractionWrite[]) => {
      store.format = EXTRACT_FORMAT;
      store.writes.push([...facts]);
      store.held = [...facts];
      return facts.length;
    },
    list: async () => store.held.filter((f) => f.ordinal < 16) as Fact[],
    aggregateCount: async () => store.held.filter((f) => f.ordinal >= 18).length,
    format: null as string | null,
    extractFormat: async () => store.format,
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
      expect(afterDone.size).toBe(0); // the note is consumed
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

const EVENTS = [
  { when: "March 2024", date: "2024-03", label: "Alpha launch", chunkIds: [C0] },
  { when: "Q3 2025", date: "2025-Q3", label: "Beta rollout", chunkIds: [C1] },
  { when: "14 February 2026", date: "2026-02-14", label: "Gamma review", chunkIds: [C0, C1] },
];
const LINKS = [
  { from: "Acme", rel: "acquired", to: "Beta Corp", chunkIds: [C0] },
  { from: "Cora", rel: "leads", to: "Project X", chunkIds: [C1] },
  { from: "Acme", rel: "owns", to: "Project X", chunkIds: [C0] },
];
/** A document extraction's answer: one good fact, a timeline and relations; `over` replaces any field. */
const answer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    facts: [GOOD],
    timeline: { events: EVENTS },
    relations: { links: LINKS },
    ...over,
  });

describe("the timeline and relations of a document extraction", () => {
  it("stores the timeline at 18 and the relations at 19 beside the facts, in one write and one model call", async () => {
    const { llm, requests } = scripted(() => answer());
    const s = setup({ llm });
    expect(await run(s)).toEqual({
      outcome: "done",
      count: 1,
      aggregates: 2,
      model: "claude-test",
    });
    expect(requests).toHaveLength(1);
    expect(s.store.writes).toHaveLength(1);
    const written = s.store.writes[0] as ExtractionWrite[];
    expect(written.map((f) => [f.ordinal, f.kind])).toEqual([
      [0, "series"],
      [18, "timeline"],
      [19, "relations"],
    ]);
    expect(written[1]).toMatchObject({
      kind: "timeline",
      events: [
        {
          at: "2024-03-01",
          precision: "month",
          when: "March 2024",
          label: "Alpha launch",
          chunkId: C0,
        },
        {
          at: "2025-07-01",
          precision: "quarter",
          when: "Q3 2025",
          label: "Beta rollout",
          chunkId: C1,
        },
        {
          at: "2026-02-14",
          precision: "day",
          when: "14 February 2026",
          label: "Gamma review",
          chunkId: C0,
        },
      ],
      chunkIds: [C0, C1],
    });
    expect(written[2]).toMatchObject({
      kind: "relations",
      entities: ["Acme", "Beta Corp", "Cora", "Project X"],
      links: [
        { from: 0, to: 1, rel: "acquired", chunkId: C0 },
        { from: 2, to: 3, rel: "leads", chunkId: C1 },
        { from: 0, to: 3, rel: "owns", chunkId: C0 },
      ],
      chunkIds: [C0, C1],
    });
  });

  it("asks the extraction's own provider (a longer answer and timeout) when there is one, and the shared one otherwise", async () => {
    const shared = scripted(() => answer());
    const own = scripted(() => answer());
    const s = setup({ llm: shared.llm });
    expect(
      await extractEffect({ ...s.d, extractLlm: own.llm }).execute(s.ref, {} as never),
    ).toMatchObject({ outcome: "done", aggregates: 2 });
    expect(own.requests).toHaveLength(1);
    expect(shared.requests).toEqual([]);
    await run(s); // no extraction provider: the shared one answers
    expect(shared.requests).toHaveLength(1);
  });

  it("keeps the old behaviour when the answer has neither field: the facts only, no aggregates key", async () => {
    const { llm } = scripted(() => JSON.stringify({ facts: [GOOD] }));
    const s = setup({ llm });
    expect(await run(s)).toEqual({ outcome: "done", count: 1, model: "claude-test" });
    expect(s.store.writes[0]?.map((f) => f.ordinal)).toEqual([0]);
  });

  it.each([
    ["fields that are not objects", { timeline: "oops", relations: [1, 2] }],
    ["null fields", { timeline: null, relations: null }],
    ["lists that are not lists", { timeline: { events: "x" }, relations: { links: {} } }],
    [
      "too few valid items",
      { timeline: { events: EVENTS.slice(0, 2) }, relations: { links: LINKS.slice(0, 2) } },
    ],
    [
      "items that are all bad",
      {
        timeline: {
          events: [{ when: "soon", date: "last year", label: "x", chunkIds: [C0] }, 5, null, "x"],
        },
        relations: { links: [{ from: "A", to: "A", rel: "is", chunkIds: [C0] }, {}, 7] },
      },
    ],
  ])("%s never cost the facts: they are stored, with no aggregate", async (_name, over) => {
    const { llm } = scripted(() => answer(over));
    const s = setup({ llm });
    expect(await run(s)).toEqual({ outcome: "done", count: 1, model: "claude-test" });
    expect(s.store.writes[0]?.map((f) => f.ordinal)).toEqual([0]);
  });

  it("drops only the bad items: a timeline with a bad date among three good events keeps the three", async () => {
    const bad = { when: "next year", date: "next year", label: "Soon", chunkIds: [C0] };
    const { llm } = scripted(() => answer({ timeline: { events: [bad, ...EVENTS] } }));
    const s = setup({ llm });
    expect(await run(s)).toMatchObject({ count: 1, aggregates: 2 });
    const t = s.store.writes[0]?.[1] as { events: { label: string }[] };
    expect(t.events.map((e) => e.label)).toEqual(["Alpha launch", "Beta rollout", "Gamma review"]);
  });

  it("cites only passages of this document: events that cite a foreign passage are dropped, and two left is no timeline", async () => {
    const foreign = (e: (typeof EVENTS)[number]) => ({ ...e, chunkIds: [randomUUID()] });
    const { llm } = scripted(() =>
      answer({ timeline: { events: [foreign(EVENTS[0] as never), EVENTS[1], EVENTS[2]] } }),
    );
    const s = setup({ llm });
    expect(await run(s)).toEqual({
      outcome: "done",
      count: 1,
      aggregates: 1,
      model: "claude-test",
    });
    expect(s.store.writes[0]?.map((f) => f.kind)).toEqual(["series", "relations"]);
  });

  it("merges the answers of several windows and dedupes across them", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const texts = Object.fromEntries(ids.map((id) => [id, "x".repeat(10_000)]));
    const answers = [
      {
        facts: [],
        timeline: {
          events: [
            { when: "2024", date: "2024", label: "One", chunkIds: [ids[0]] },
            { when: "2025", date: "2025", label: "Two", chunkIds: [ids[1]] },
          ],
        },
      },
      {
        facts: [],
        timeline: {
          events: [
            { when: "2025", date: "2025", label: "two", chunkIds: [ids[2]] },
            { when: "2026", date: "2026", label: "Three", chunkIds: [ids[2]] },
          ],
        },
      },
    ];
    let n = 0;
    const { llm, requests } = scripted(() => JSON.stringify(answers[n++]));
    const s = setup({ llm, texts });
    expect(await run(s)).toEqual({
      outcome: "done",
      count: 0,
      aggregates: 1,
      model: "claude-test",
    });
    expect(requests).toHaveLength(2);
    const t = s.store.writes[0]?.[0] as {
      kind: string;
      ordinal: number;
      events: { label: string; chunkId: string }[];
    };
    expect([t.kind, t.ordinal]).toEqual(["timeline", 18]);
    expect(t.events.map((e) => [e.label, e.chunkId])).toEqual([
      ["One", ids[0]],
      ["Two", ids[1]], // the first spelling and the first passage of the duplicate
      ["Three", ids[2]],
    ]);
  });

  it("asks a document extraction for the two fields, and never asks chat's extraction for them", async () => {
    const { llm, requests } = scripted(() => answer());
    await run(setup({ llm }));
    const system = String(requests[0]?.system);
    expect(system).toBe(`${EXTRACT_DOCUMENT_SYSTEM}\n\n${UNTRUSTED_CONTENT_SYSTEM_NOTE}`);
    expect(system.startsWith("You extract facts")).toBe(true);
    for (const phrase of [
      '"timeline"',
      '"relations"',
      "at most 40",
      "at most 30",
      "Never infer, compute or complete a date",
      "relative",
      "at most 2 passage ids",
    ])
      expect(system, phrase).toContain(phrase);
    // chat's call is byte-identical to what it was: the original prompt, no aggregates
    const chat = scripted(() => '{"facts":[]}');
    await askForFacts(chat.llm, [{ id: C0, text: "t" }]);
    expect(String(chat.requests[0]?.system)).toBe(
      `${EXTRACT_SYSTEM}\n\n${UNTRUSTED_CONTENT_SYSTEM_NOTE}`,
    );
    expect(String(chat.requests[0]?.system)).not.toContain("timeline");
  });

  it("askForExtraction returns the facts and the raw, unvalidated aggregates of the window", async () => {
    const { llm } = scripted(() => answer());
    expect(await askForExtraction(llm, [{ id: C0, text: "t" }])).toEqual({
      drafts: [GOOD],
      events: EVENTS,
      links: LINKS,
    });
  });

  it("a refusal clears a timeline and relations a previous run stored, with the facts", async () => {
    const llm = Object.assign(
      {
        complete: async () => {
          throw new LlmRefusalError();
        },
      },
      { model: "claude-test" },
    );
    const s = setup({ llm });
    const { timeline, relations } = aggregateFacts(C0);
    s.store.held = [{ ...GOOD, ordinal: 0 } as Fact, timeline, relations];
    expect(await run(s)).toEqual({ outcome: "done", count: 0, model: "claude-test" });
    expect(s.store.held).toEqual([]);
  });

  it("a new extraction with no timeline replaces the old one (the write carries no ordinal 18)", async () => {
    const { llm } = scripted(() => JSON.stringify({ facts: [GOOD], relations: { links: LINKS } }));
    const s = setup({ llm });
    s.store.held = [{ ...GOOD, ordinal: 0 } as Fact, aggregateFacts(C0).timeline];
    await run(s);
    expect(s.store.held.map((f) => f.ordinal)).toEqual([0, 19]);
  });

  describe("a re-run (-r<n> execution) over stored aggregates", () => {
    const rerunCtx = (s: ReturnType<typeof setup>, n = 1) =>
      ({ executionId: visualizeExecutionId(s.ref.userId, s.ref.documentId, 1, n) }) as never;

    it("reports the timeline and relations it keeps and makes no model call", async () => {
      const { llm, requests } = scripted(() => answer());
      const s = setup({ llm });
      const { timeline, relations } = aggregateFacts(C0);
      s.store.held = [{ ...GOOD, ordinal: 0 } as Fact, timeline, relations];
      expect(await extractEffect(s.d).execute(s.ref, rerunCtx(s))).toEqual({
        outcome: "done",
        count: 1,
        aggregates: 2,
        model: "claude-test",
      });
      expect(requests).toEqual([]);
      expect(s.store.writes).toEqual([]);
    });

    it("a document that has only a timeline is re-planned, not extracted again, and reports it", async () => {
      const { llm, requests } = scripted(() => answer());
      const s = setup({ llm });
      s.store.held = [aggregateFacts(C0).timeline];
      expect(await extractEffect(s.d).execute(s.ref, rerunCtx(s))).toEqual({
        outcome: "done",
        count: 0,
        aggregates: 1,
        model: "claude-test",
      });
      expect(requests).toEqual([]);
    });
  });
});

describe("fix round 1: a lenient answer and a slow model", () => {
  it("I1: an unknown or misnamed top-level key never costs the facts", async () => {
    const { llm } = scripted(() =>
      JSON.stringify({ facts: [GOOD], relationships: { links: LINKS }, events: EVENTS, note: "x" }),
    );
    const s = setup({ llm });
    expect(await run(s)).toEqual({ outcome: "done", count: 1, model: "claude-test" });
    expect(s.store.writes[0]?.map((f) => f.ordinal)).toEqual([0]);
  });

  it("I1: a fact that is malformed still fails its window (facts stay strict per item)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { llm } = scripted(() => JSON.stringify({ facts: [{ kind: "nope" }], extra: 1 }));
    await expect(run(setup({ llm }))).rejects.toThrow(/^ingest step failed: visualize-extract$/);
  });

  /** A model that never answers until the step's clock aborts it (as a provider honours the abort signal). */
  const hanging = (afterCalls = 0, answerText = () => JSON.stringify({ facts: [] })) => {
    const calls = { n: 0 };
    const llm = Object.assign(
      {
        complete: (r: LlmRequest) => {
          calls.n++;
          if (calls.n <= afterCalls)
            return Promise.resolve({ content: answerText(), stopReason: "end_turn" as const });
          return new Promise<never>((_ok, no) => {
            r.signal?.addEventListener("abort", () => no(new Error("aborted")), { once: true });
          });
        },
      },
      { model: "claude-test" },
    );
    return { llm, calls };
  };

  it("I2: a model slower than the step clock on a single window ends visuals-model-unavailable", async () => {
    const { llm } = hanging();
    const s = setup({ llm });
    expect(await extractEffect({ ...s.d, stepTimeoutMs: 30 }).execute(s.ref, {} as never)).toEqual({
      outcome: "failed",
      code: "visuals-model-unavailable",
    });
    expect(s.store.writes).toEqual([]);
  });

  it("I2: a multi-window document whose windows together outlast the step clock ends visuals-model-unavailable", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const texts = Object.fromEntries(ids.map((id) => [id, "x".repeat(10_000)]));
    const { llm, calls } = hanging(1); // the first window answers, the second never does
    const s = setup({ llm, texts });
    expect(await extractEffect({ ...s.d, stepTimeoutMs: 30 }).execute(s.ref, {} as never)).toEqual({
      outcome: "failed",
      code: "visuals-model-unavailable",
    });
    expect(calls.n).toBe(2); // no retry: the clock is deterministic for this document
    expect(s.store.writes).toEqual([]);
  });

  it("I2: a step-clock expiry makes exactly one attempt (no retry, no backoff) and ends visuals-model-unavailable", async () => {
    const { llm, calls } = hanging();
    const sleep = vi.fn(async () => {});
    const s = setup({ llm, sleep });
    expect(await extractEffect({ ...s.d, stepTimeoutMs: 30 }).execute(s.ref, {} as never)).toEqual({
      outcome: "failed",
      code: "visuals-model-unavailable",
    });
    expect(calls.n).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(s.store.writes).toEqual([]);
  });

  it("I2: each window of an 8-window document is asked for its share of events and links, at least 3", async () => {
    const ids = Array.from({ length: 8 }, () => randomUUID());
    const texts = Object.fromEntries(ids.map((id) => [id, "x".repeat(EXTRACT_WINDOW_CHARS)]));
    const { llm, requests } = scripted(() => JSON.stringify({ facts: [] }));
    await run(setup({ llm, texts }));
    expect(requests).toHaveLength(8);
    for (const r of requests) {
      expect(r.system).toContain("dated events the document narrates, at most 5,");
      expect(r.system).toContain("relate to each other, at most 4.");
      expect(r.system).not.toContain("at most 40,");
    }
    // 17 windows: the floor of 3 holds
    expect(extractDocumentSystem(17)).toContain("narrates, at most 3,");
    expect(extractDocumentSystem(17)).toContain("each other, at most 3.");
    // one window: the whole caps
    expect(extractDocumentSystem(1)).toContain("narrates, at most 40,");
    expect(extractDocumentSystem(1)).toContain("each other, at most 30.");
    expect(EXTRACT_DOCUMENT_SYSTEM).toBe(extractDocumentSystem(1));
  });

  it("M2: one window's flood of items does not crowd out a later window's events", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const texts = Object.fromEntries(ids.map((id) => [id, "x".repeat(10_000)]));
    const junk = Array.from({ length: 200 }, (_, i) => ({
      when: "x",
      date: "bad",
      label: `j${i}`,
      chunkIds: [ids[0]],
    }));
    const good = [
      { when: "2024", date: "2024", label: "A", chunkIds: [ids[2]] },
      { when: "2025", date: "2025", label: "B", chunkIds: [ids[2]] },
      { when: "2026", date: "2026", label: "C", chunkIds: [ids[2]] },
    ];
    const answers = [
      { facts: [], timeline: { events: junk } },
      { facts: [], timeline: { events: good } },
    ];
    let n = 0;
    const { llm } = scripted(() => JSON.stringify(answers[n++]));
    const s = setup({ llm, texts });
    expect(await run(s)).toMatchObject({ aggregates: 1 });
  });

  it("keeps the share fair for many windows: eleven flooded windows leave room for the twelfth's events", async () => {
    const ids = Array.from({ length: 12 }, () => randomUUID());
    const texts = Object.fromEntries(ids.map((id) => [id, "x".repeat(EXTRACT_WINDOW_CHARS)]));
    const flood = (w: number) =>
      Array.from({ length: 200 }, (_, i) => ({
        when: "x",
        date: "bad",
        label: `j${w}-${i}`,
        chunkIds: [ids[w]],
      }));
    const good = ["2024", "2025", "2026"].map((y) => ({
      when: y,
      date: y,
      label: `e${y}`,
      chunkIds: [ids[11]],
    }));
    const answers = [
      ...Array.from({ length: 11 }, (_, w) => ({ facts: [], timeline: { events: flood(w) } })),
      { facts: [], timeline: { events: good } },
    ];
    let n = 0;
    const { llm, requests } = scripted(() => JSON.stringify(answers[n++]));
    const s = setup({ llm, texts });
    expect(await run(s)).toMatchObject({ aggregates: 1 });
    expect(requests).toHaveLength(12);
  });

  it("M1: only the document flow's deps carry the extraction provider, never chat's or the planner's", () => {
    const src = readFileSync(join(__dirname, "../../compose.ts"), "utf8");
    expect(src.match(/extractLlm/g)).toHaveLength(1);
    expect(src.indexOf("extractLlm")).toBeLessThan(src.indexOf("const visualizeTurn"));
    expect(src).not.toMatch(/visualsPlanner\([^)]*visualsExtract/);
  });
});

describe("re-extract once (spec D5): a re-run the user asked for extracts a pre-c2 document", () => {
  const ctxOf = (s: ReturnType<typeof setup>, n = 1) =>
    ({ executionId: visualizeExecutionId(s.ref.userId, s.ref.documentId, 1, n) }) as never;
  const noteFor = (s: ReturnType<typeof setup>, n = 1) =>
    new Set([visualizeExecutionId(s.ref.userId, s.ref.documentId, 1, n)]);
  const existing = { ...GOOD, ordinal: 0 } as Fact;

  it("a re-run the user asked for extracts a document with no stamp, stamps it, and consumes its note", async () => {
    const { llm, requests } = scripted(() => answer());
    const s = setup({ llm });
    s.store.held = [existing];
    expect(s.store.format).toBeNull();
    const reextract = noteFor(s);
    expect(await extractEffect({ ...s.d, reextract }).execute(s.ref, ctxOf(s))).toEqual({
      outcome: "done",
      count: 1,
      aggregates: 2,
      model: "claude-test",
    });
    expect(requests).toHaveLength(1);
    expect(s.store.held.map((f) => f.ordinal)).toEqual([0, 18, 19]);
    expect(s.store.format).toBe(EXTRACT_FORMAT);
    expect(reextract.size).toBe(0);
  });

  it("a second re-run does not extract, even for a document whose extraction found no timeline or relations", async () => {
    const { llm, requests } = scripted(() => JSON.stringify({ facts: [GOOD] }));
    const s = setup({ llm });
    s.store.held = [existing];
    await extractEffect({ ...s.d, reextract: noteFor(s, 1) }).execute(s.ref, ctxOf(s, 1));
    expect(requests).toHaveLength(1);
    expect(s.store.held.map((f) => f.ordinal)).toEqual([0]);
    const second = noteFor(s, 2);
    expect(await extractEffect({ ...s.d, reextract: second }).execute(s.ref, ctxOf(s, 2))).toEqual({
      outcome: "done",
      count: 1,
      model: "claude-test",
    });
    expect(requests).toHaveLength(1);
    expect(second.size).toBe(0);
  });

  it("the re-run of a document a c2 extraction stamped does not extract", async () => {
    const { llm, requests } = scripted(() => answer());
    const s = setup({ llm });
    s.store.held = [existing];
    s.store.format = EXTRACT_FORMAT;
    expect(await extractEffect({ ...s.d, reextract: noteFor(s) }).execute(s.ref, ctxOf(s))).toEqual(
      {
        outcome: "done",
        count: 1,
        model: "claude-test",
      },
    );
    expect(requests).toEqual([]);
    expect(s.store.writes).toEqual([]);
  });

  it("an older stamp counts as pre-c2: a later bump of the format re-extracts once more", async () => {
    const { llm, requests } = scripted(() => answer());
    const s = setup({ llm });
    s.store.held = [existing];
    s.store.format = "docmind.extract@1";
    await extractEffect({ ...s.d, reextract: noteFor(s) }).execute(s.ref, ctxOf(s));
    expect(requests).toHaveLength(1);
    expect(s.store.format).toBe(EXTRACT_FORMAT);
  });

  it("a re-ingest whose extraction failed leaves the stamp NULL, so the user's re-run extracts", async () => {
    const { llm, requests } = scripted(() => answer());
    const s = setup({ llm });
    s.store.held = []; // the re-ingest cleared the facts; its extraction failed: no stamp
    s.store.format = null;
    await extractEffect({ ...s.d, reextract: noteFor(s) }).execute(s.ref, ctxOf(s));
    expect(requests).toHaveLength(1);
    expect(s.store.format).toBe(EXTRACT_FORMAT);
  });

  it("a zero-fact document whose last run was done is extracted by the user's re-run when it has no stamp, and not when stamped", async () => {
    const done = { last: async () => ({ run: 0, state: "done" as const, code: null }) };
    const { llm, requests } = scripted(() => answer());
    const s = setup({ llm });
    await extractEffect({ ...s.d, runs: done, reextract: noteFor(s) }).execute(s.ref, ctxOf(s));
    expect(requests).toHaveLength(1);
    const t = setup({ llm });
    t.store.format = EXTRACT_FORMAT;
    await extractEffect({ ...t.d, runs: done, reextract: noteFor(t) }).execute(t.ref, ctxOf(t));
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["a pre-c2 document (no stamp)", null],
    ["a document an older format stamped", "docmind.extract@1"],
    ["a document the current format stamped", EXTRACT_FORMAT],
  ])(
    "a boot pass never extracts: an un-noted re-run of %s re-plans over its stored facts, and another run's note is left alone",
    async (_name, format) => {
      const { llm, requests } = scripted(() => answer());
      const s = setup({ llm });
      s.store.held = [existing];
      s.store.format = format;
      const reextract = noteFor(s, 7);
      expect(await extractEffect({ ...s.d, reextract }).execute(s.ref, ctxOf(s, 1))).toEqual({
        outcome: "done",
        count: 1,
        model: "claude-test",
      });
      expect(requests).toEqual([]);
      expect(s.store.writes).toEqual([]);
      expect(s.store.format).toBe(format);
      expect(reextract.size).toBe(1);
    },
  );

  it("a first attempt that fails keeps the note: the retried step extracts again, stamps the document and only then spends the note", async () => {
    const replies = ["not json", answer()];
    const noteSeen: boolean[] = [];
    const { llm, requests } = scripted(() => {
      const reply = replies.shift() as string;
      noteSeen.push(reextract.has(id));
      return reply;
    });
    const s = setup({ llm });
    s.store.held = [existing];
    const id = visualizeExecutionId(s.ref.userId, s.ref.documentId, 1, 1);
    const reextract = new Set([id]);
    expect(await extractEffect({ ...s.d, reextract }).execute(s.ref, ctxOf(s))).toEqual({
      outcome: "done",
      count: 1,
      aggregates: 2,
      model: "claude-test",
    });
    expect(requests).toHaveLength(2);
    expect(noteSeen).toEqual([true, true]);
    expect(s.store.held.map((f) => f.ordinal)).toEqual([0, 18, 19]);
    expect(s.store.format).toBe(EXTRACT_FORMAT);
    expect(reextract.size).toBe(0);
  });

  it("a write that fails keeps the note too: the retry extracts again", async () => {
    const { llm, requests } = scripted(() => answer());
    const s = setup({ llm });
    s.store.held = [existing];
    const id = visualizeExecutionId(s.ref.userId, s.ref.documentId, 1, 1);
    const reextract = new Set([id]);
    const write = s.store.replace;
    let failures = 1;
    s.store.replace = async (r, facts) => {
      if (failures-- > 0) throw new LlmUnavailableError();
      return write(r, facts);
    };
    await extractEffect({ ...s.d, reextract }).execute(s.ref, ctxOf(s));
    expect(requests).toHaveLength(2);
    expect(s.store.format).toBe(EXTRACT_FORMAT);
    expect(reextract.size).toBe(0);
  });

  it("the automatic run extracts as before and stamps the format (a new upload or re-ingest)", async () => {
    const { llm, requests } = scripted(() => answer());
    const s = setup({ llm });
    const ctx = { executionId: visualizeExecutionId(s.ref.userId, s.ref.documentId, 1) } as never;
    await extractEffect(s.d).execute(s.ref, ctx);
    expect(requests).toHaveLength(1);
    expect(s.store.format).toBe(EXTRACT_FORMAT);
  });

  it('backstop (the real guard is the type `Pick<VisualFactStore, "list">` and the behavioural test in visualize-turn/flow.test.ts): chat\'s sources do not mention the stamp', () => {
    for (const file of [
      "../visualize-turn/steps.ts",
      "../visualize-turn/deps.ts",
      "../visualize-turn/pgTurnFacts.ts",
    ]) {
      const source = readFileSync(resolve(__dirname, file), "utf8");
      expect(source, file).not.toMatch(
        /extractFormat|EXTRACT_FORMAT|visual_extract_format|aggregateCount/,
      );
    }
  });
});
