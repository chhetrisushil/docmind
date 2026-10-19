import { DocumentStats, DocumentSummary } from "@docmind/contracts";
import { ParseAbortedError } from "@docmind/parsers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../../db/testSupport";
import { statsBind, summaryBind } from "../../documents/repo";
import { U2 } from "../../documents/testHarness";
import { DocumentGoneError } from "./errors";
import { type PgFixture, startPgFixture } from "./pgFixture";
import { PgDocumentResults } from "./pgResults";

const stats: DocumentStats = {
  wordCount: 4,
  pageCount: null,
  readingTimeMinutes: 0,
  language: null,
  outline: ["Quarterly revenue forecast"],
  dates: [],
  numbers: [],
};
const summary: DocumentSummary = {
  tldr: "A distinctive summary about quarterly revenue.",
  keyPoints: [],
  entities: [],
  topics: [],
  suggestedQuestions: [],
};

describe.skipIf(!PG_URL)("PgDocumentResults (needs DOCMIND_TEST_PG_URL)", () => {
  let f: PgFixture;
  beforeAll(async () => {
    f = await startPgFixture();
  });
  afterAll(async () => {
    await f?.close();
  });

  const raw = async (id: string, column: "stats_enc" | "summary_enc") =>
    (await f.db.owner.query(`SELECT ${column} AS v FROM documents WHERE id = $1`, [id])).rows[0].v;

  it("seals stats: the owner opens them, the raw column is an envelope without the plaintext", async () => {
    const ref = await f.doc("5".repeat(64));
    const store = new PgDocumentResults(f.app, f.fields);
    await store.putStats(ref, stats);
    const col = await raw(ref.documentId, "stats_enc");
    expect(col.__loomEnc).toBe("loom/aes-256-gcm");
    expect(JSON.stringify(col)).not.toContain("Quarterly revenue forecast");
    const opened = await f.fields.forUser(ref.userId).open(statsBind(ref.documentId), col);
    expect(DocumentStats.parse(opened)).toEqual(stats);
  });

  it("another owner's put is DocumentGoneError", async () => {
    const ref = await f.doc("6".repeat(64));
    const store = new PgDocumentResults(f.app, f.fields);
    await expect(store.putStats({ ...ref, userId: U2 }, stats)).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
    expect(await raw(ref.documentId, "stats_enc")).toBeNull();
  });

  it("an aborted signal rolls the put back", async () => {
    const ref = await f.doc("7".repeat(64));
    const store = new PgDocumentResults(f.app, f.fields);
    const ac = new AbortController();
    ac.abort();
    await expect(store.putStats(ref, stats, ac.signal)).rejects.toBeInstanceOf(ParseAbortedError);
    expect(await raw(ref.documentId, "stats_enc")).toBeNull();
  });

  it("hasSummary is false until putSummary, then true; the summary is sealed", async () => {
    const ref = await f.doc("8".repeat(64));
    const store = new PgDocumentResults(f.app, f.fields);
    expect(await store.hasSummary(ref)).toBe(false);
    await store.putSummary(ref, summary);
    expect(await store.hasSummary(ref)).toBe(true);
    const col = await raw(ref.documentId, "summary_enc");
    expect(col.__loomEnc).toBe("loom/aes-256-gcm");
    expect(JSON.stringify(col)).not.toContain("distinctive summary");
    const opened = await f.fields.forUser(ref.userId).open(summaryBind(ref.documentId), col);
    expect(DocumentSummary.parse(opened)).toEqual(summary);
  });

  it("hasSummary for another owner is DocumentGoneError", async () => {
    const ref = await f.doc("9".repeat(64));
    const store = new PgDocumentResults(f.app, f.fields);
    await expect(store.hasSummary({ ...ref, userId: U2 })).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
  });
});
