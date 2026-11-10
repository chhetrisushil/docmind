import { randomUUID } from "node:crypto";
import type { ParsedDocument } from "@docmind/parsers";
import type { LlmProvider, LlmRequest } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TagKeys } from "../../../crypto/tagKeys";
import { PG_URL } from "../../../db/testSupport";
import { TagService } from "../../../tags/service";
import { type PgFixture, startPgFixture } from "../pgFixture";
import { PgDocumentResults } from "../pgResults";
import { summarizeEffect } from "./summarize";

const PARSED: ParsedDocument = {
  text: "one",
  sections: [{ headingPath: [], text: "one", locator: { kind: "chars", start: 0, end: 3 } }],
  media: [],
};

describe.skipIf(!PG_URL)(
  "the summarize step with the real tag service (needs DOCMIND_TEST_PG_URL)",
  () => {
    let fx: PgFixture;
    beforeAll(async () => {
      fx = await startPgFixture();
    });
    afterAll(async () => void (await fx?.close()));

    it("writes the document's suggestions, mapped onto its owner's existing tags, and the sealed summary", async () => {
      const ref = await fx.doc(randomUUID().replaceAll("-", "").padEnd(64, "0"));
      const tags = new TagService(fx.app, fx.fields, new TagKeys(fx.keys));
      await tags.create(ref, "Finance");
      const llm: LlmProvider & { model: string } = {
        model: "claude-test",
        complete: async (r: LlmRequest) => ({
          content: (r.system ?? "").startsWith("You combine")
            ? JSON.stringify({
                tldr: "T",
                keyPoints: [],
                entities: [],
                topics: [],
                suggestedQuestions: [],
                suggestedTags: ["FINANCE", "Brand new"],
              })
            : JSON.stringify({ summary: "s", entities: [] }),
          stopReason: "end_turn",
        }),
      };
      const results = new PgDocumentResults(fx.app, fx.fields);
      const effect = summarizeEffect({
        guard: { begin: async () => {} },
        parsed: {
          put: async () => {},
          take: async () => PARSED,
          has: async () => true,
          drop: async () => {},
        },
        chunks: {
          replace: async () => 0,
          count: async () => 1,
          read: async () => [],
          sectionsOf: async () => [],
        },
        results,
        entities: { replaceForDocument: async () => 0, sharedWith: async () => [] },
        llm,
        tags,
        summaryMaxChars: 1_000,
        sleep: async () => {},
      });
      expect(await effect.execute(ref, {} as never)).toMatchObject({ outcome: "done" });
      expect(await results.hasSummary(ref)).toBe(true);
      expect((await tags.detail(ref, ref.documentId))?.suggestedTags).toEqual([
        "Finance",
        "Brand new",
      ]);
      const raw = (
        await fx.db.owner.query("SELECT to_jsonb(s) AS r FROM document_tag_suggestions s")
      ).rows;
      expect(JSON.stringify(raw)).not.toContain("Brand new");
    });
  },
);
