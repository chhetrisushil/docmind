import { randomUUID } from "node:crypto";
import type { DocumentProgressEvent } from "@docmind/contracts";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../config";
import { TagKeys } from "../../crypto/tagKeys";
import { PG_URL } from "../../db/testSupport";
import { InMemoryProgressBus } from "../../documents/progress";
import { testIdSource } from "../../opaqueIds/testing";
import { TagService } from "../../tags/service";
import { type PgFixture, startPgFixture } from "../ingest-document/pgFixture";
import { PgDocumentResults } from "../ingest-document/pgResults";
import { loomSuggestTagsStarter } from "./start";

describe.skipIf(!PG_URL)("suggest-tags through Loom (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => void (await fx?.close()));

  it("runs durably, stores suggestions once for a double click, and leaves no tag or summary text in the log", async () => {
    const ref = await fx.doc(randomUUID().replaceAll("-", "").padEnd(64, "0"));
    await new PgDocumentResults(fx.app, fx.fields).putSummary(ref, {
      tldr: "Zebra-Secret-Summary",
      keyPoints: [],
      entities: [],
      topics: [],
      suggestedQuestions: [],
    });
    const tags = new TagService(fx.app, fx.fields, new TagKeys(fx.keys));
    const events: DocumentProgressEvent[] = [];
    const bus = new InMemoryProgressBus();
    bus.subscribe({ userId: ref.userId }, (e) => events.push(e));
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const llm: LlmProvider = {
      complete: async () => {
        calls++;
        await gate;
        return {
          content: JSON.stringify({ suggestedTags: ["Zebra-Secret-Tag"] }),
          stopReason: "end_turn",
        };
      },
    };
    const log = new InMemoryAsyncEventStore();
    const app = buildApp({ kind: "custom", eventStore: log }, undefined, {
      suggestTags: { pool: fx.app, fields: fx.fields, tags, bus, llm },
    });
    try {
      const ids = testIdSource();
      const starter = loomSuggestTagsStarter(app.runtime, { ids });
      const [a, b] = await Promise.all([starter.start(ref), starter.start(ref)]);
      expect([a.kind, b.kind].sort()).toEqual(["running", "started"]);
      release();
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(calls).toBe(1);
      expect((await tags.detail(ref, ref.documentId))?.suggestedTags).toEqual(["Zebra-Secret-Tag"]);
      expect(events[0]).toEqual({
        documentId: ref.documentId,
        status: "ready",
        step: "finalize",
        tags: "suggested",
      });
      const id = (await ids.ensureUser(ref)).suggestTags(ref.documentId, 1);
      await vi.waitFor(async () =>
        expect(JSON.stringify(await log.read(id))).toContain("EXECUTION_COMPLETED"),
      );
      const text = JSON.stringify(await log.read(id));
      expect(text).not.toContain("Zebra");
      expect(text).toContain('"outcome":"suggested"');
    } finally {
      await app.close();
    }
  });
});
