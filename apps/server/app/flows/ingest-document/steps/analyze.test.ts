import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analyzeDocument } from "../analyze";
import { DocumentGoneError } from "../errors";
import type { IngestStartInput } from "../flow";
import type { ParsedStore } from "../pgParsed";
import { fakeResults } from "../testing";
import { analyzeEffect } from "./analyze";

const parsed = {
  text: "one two three four",
  sections: [
    {
      headingPath: ["H"],
      text: "one two three four",
      locator: { kind: "chars" as const, start: 0, end: 18 },
    },
  ],
  media: [],
};
const ref = (): IngestStartInput => ({
  tenantId: randomUUID(),
  userId: randomUUID(),
  documentId: randomUUID(),
});
const store = (take: ParsedStore["take"]): ParsedStore => ({
  put: async () => {},
  take,
  has: async () => true,
  drop: async () => {},
});
const run = (effect: ReturnType<typeof analyzeEffect>, r = ref()) => effect.execute(r, {} as never);
const guard = { begin: async () => {} };

describe("analyze step", () => {
  it("stores analyzeDocument(parsed) and returns the word count", async () => {
    const results = fakeResults();
    const r = ref();
    const effect = analyzeEffect({ guard, parsed: store(async () => parsed), results });
    expect(await run(effect, r)).toEqual({ outcome: "done", count: 4 });
    expect(results.stats.get(r.documentId)).toEqual(analyzeDocument(parsed));
  });

  it("fails with the fixed message when there is no parsed row", async () => {
    const effect = analyzeEffect({
      guard,
      parsed: store(async () => undefined),
      results: fakeResults(),
      sleep: async () => {},
    });
    await expect(run(effect)).rejects.toThrow(/^ingest step failed: analyze$/);
  });

  it("is document_gone when the store says the document is gone", async () => {
    const results = fakeResults();
    results.putStats = async () => {
      throw new DocumentGoneError();
    };
    const effect = analyzeEffect({ guard, parsed: store(async () => parsed), results });
    expect(await run(effect)).toEqual({ outcome: "document_gone" });
  });

  it("is document_gone when the guard says so", async () => {
    const gone = {
      begin: async () => {
        throw new DocumentGoneError();
      },
    };
    const effect = analyzeEffect({
      guard: gone,
      parsed: store(async () => parsed),
      results: fakeResults(),
    });
    expect(await run(effect)).toEqual({ outcome: "document_gone" });
  });
});
