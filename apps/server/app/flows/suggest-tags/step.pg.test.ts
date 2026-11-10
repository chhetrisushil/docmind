import { randomUUID } from "node:crypto";
import type { DocumentProgressEvent } from "@docmind/contracts";
import { LlmRefusalError, LlmUnavailableError } from "@docmind/llm-anthropic";
import type { LlmProvider, LlmRequest } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TagKeys } from "../../crypto/tagKeys";
import { PG_URL } from "../../db/testSupport";
import { InMemoryProgressBus } from "../../documents/progress";
import { TagService } from "../../tags/service";
import { type PgFixture, startPgFixture } from "../ingest-document/pgFixture";
import { PgDocumentResults } from "../ingest-document/pgResults";
import { suggestTagsEffect } from "./step";

const SUMMARY = {
  tldr: "Quarterly summary tldr",
  keyPoints: ["Revenue grew"],
  entities: [],
  topics: ["finance"],
  suggestedQuestions: [],
};

describe.skipIf(!PG_URL)("the suggest-tags step (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  let tags: TagService;
  let results: PgDocumentResults;
  beforeAll(async () => {
    fx = await startPgFixture();
    tags = new TagService(fx.app, fx.fields, new TagKeys(fx.keys));
    results = new PgDocumentResults(fx.app, fx.fields);
  });
  afterAll(async () => void (await fx?.close()));

  async function setup(
    o: {
      summary?: boolean;
      reply?: (n: number) => string | Error;
      tags?: Pick<TagService, "suggestionContext" | "putSuggestions">;
    } = {},
  ) {
    const ref = await fx.doc(randomUUID().replaceAll("-", "").padEnd(64, "0"));
    if (o.summary !== false) await results.putSummary(ref, SUMMARY);
    const requests: LlmRequest[] = [];
    const events: DocumentProgressEvent[] = [];
    const bus = new InMemoryProgressBus();
    bus.subscribe({ userId: ref.userId }, (e) => events.push(e));
    const sleeps: number[] = [];
    const llm: LlmProvider = {
      complete: async (r) => {
        requests.push(r);
        const out = (o.reply ?? (() => JSON.stringify({ suggestedTags: ["Finance", "New idea"] })))(
          requests.length,
        );
        if (out instanceof Error) throw out;
        return { content: out, stopReason: "end_turn" };
      },
    };
    const effect = suggestTagsEffect({
      pool: fx.app,
      fields: fx.fields,
      tags: o.tags ?? tags,
      bus,
      llm,
      sleep: async (ms) => void sleeps.push(ms),
    });
    return { ref, requests, events, sleeps, run: () => effect.execute(ref, {} as never) };
  }

  it("reads only the stored summary and the tag names, stores normalised suggestions and announces them", async () => {
    const s = await setup();
    await tags.create(s.ref, "finance");
    expect(await s.run()).toEqual({ outcome: "suggested" });
    expect(s.requests).toHaveLength(1);
    const sent = JSON.stringify(s.requests[0]);
    expect(sent).toContain("Quarterly summary tldr");
    expect(sent).toContain("Revenue grew");
    expect(sent).not.toContain("Quarterly report"); // the document's title: not read
    expect(sent).toContain('[\\"finance\\"]'); // the user's existing tag, quoted
    expect((await tags.detail(s.ref, s.ref.documentId))?.suggestedTags).toEqual([
      "finance",
      "New idea",
    ]);
    expect(s.events).toEqual([
      { documentId: s.ref.documentId, status: "ready", step: "finalize", tags: "suggested" },
    ]);
  });

  it("drops a name the document already has and replaces earlier suggestions", async () => {
    const s = await setup();
    await tags.putSuggestions(s.ref, ["stale"]);
    await tags.addToDocument(s.ref, s.ref.documentId, "Finance");
    expect(await s.run()).toEqual({ outcome: "suggested" });
    expect((await tags.detail(s.ref, s.ref.documentId))?.suggestedTags).toEqual(["New idea"]);
  });

  it("a missing or malformed answer is empty, clears the row and still announces", async () => {
    const s = await setup({ reply: () => JSON.stringify({ suggestedTags: 42 }) });
    await tags.putSuggestions(s.ref, ["stale"]);
    expect(await s.run()).toEqual({ outcome: "empty" });
    expect((await tags.detail(s.ref, s.ref.documentId))?.suggestedTags).toEqual([]);
    expect(s.events.map((e) => e.tags)).toEqual(["suggested"]);
  });

  it("fails with the failed event when the document has no summary, without a model call", async () => {
    const s = await setup({ summary: false });
    expect(await s.run()).toEqual({ outcome: "failed" });
    expect(s.requests).toHaveLength(0);
    expect(s.events.map((e) => e.tags)).toEqual(["failed"]);
  });

  it("retries an unavailable model or a garbled answer, then fails with the event", async () => {
    const s = await setup({ reply: () => new LlmUnavailableError(503) });
    expect(await s.run()).toEqual({ outcome: "failed" });
    expect(s.requests).toHaveLength(3);
    expect(s.sleeps).toEqual([2_000, 4_000]);
    expect(s.events.map((e) => e.tags)).toEqual(["failed"]);
    const garbled = await setup({
      reply: (n) => (n < 3 ? "not json" : JSON.stringify({ suggestedTags: ["ok"] })),
    });
    expect(await garbled.run()).toEqual({ outcome: "suggested" });
    expect(garbled.requests).toHaveLength(3);
  });

  it("does not retry a refusal", async () => {
    const s = await setup({ reply: () => new LlmRefusalError() });
    expect(await s.run()).toEqual({ outcome: "failed" });
    expect(s.requests).toHaveLength(1);
    expect(s.events.map((e) => e.tags)).toEqual(["failed"]);
  });

  it("is quiet for a document that is gone", async () => {
    const gone = await setup();
    await fx.db.owner.query("DELETE FROM documents WHERE id = $1", [gone.ref.documentId]);
    expect(await gone.run()).toEqual({ outcome: "failed" });
    expect(gone.events).toEqual([]);
    expect(gone.requests).toHaveLength(0);
  });

  it("puts no tag or summary text in the output, the event or the log when storing fails (preflight F6)", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = await setup({
        tags: {
          suggestionContext: (ref) => tags.suggestionContext(ref),
          // The model answered "New idea", and the store fails with a message that holds it: nothing may carry it on.
          putSuggestions: async () => {
            throw new Error("storage failed for New idea");
          },
        },
      });
      const out = await s.run();
      expect(out).toEqual({ outcome: "failed" });
      expect(s.requests).toHaveLength(1);
      expect(s.events.map((e) => e.tags)).toEqual(["failed"]);
      expect(logged).toHaveBeenCalled(); // the failure is logged by class, so the check below can fail
      const seen = JSON.stringify([out, s.events, logged.mock.calls]);
      for (const text of ["New idea", "storage failed", "Quarterly summary tldr"])
        expect(seen).not.toContain(text);
    } finally {
      logged.mockRestore();
    }
  });
});
