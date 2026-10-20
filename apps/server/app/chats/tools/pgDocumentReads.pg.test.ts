import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../../db/tenant";
import { PG_URL } from "../../db/testSupport";
import { insertDocument, summaryBind, titleBind } from "../../documents/repo";
import { T1, T2, U1, U1B, newDocument } from "../../documents/testHarness";
import { type PgFixture, startPgFixture } from "../../flows/ingest-document/pgFixture";
import { UPLOADED } from "../../status/model";
import { PgDocumentReads } from "./pgDocumentReads";

describe.skipIf(!PG_URL)("PgDocumentReads (needs DOCMIND_TEST_PG_URL)", () => {
  let f: PgFixture;
  let reads: PgDocumentReads;
  const asked: unknown[] = [];
  const ids: Record<string, string> = {};

  async function seed(owner: string, tenant: string, fp: string, title: string): Promise<string> {
    const base = await newDocument(f.fields, tenant, owner, fp);
    const doc = {
      ...base,
      titleEnc: await f.fields.forUser(owner).seal(titleBind(base.id), title),
    };
    await withTenant(f.app, tenant, (tx) => insertDocument(tx, doc));
    return base.id;
  }

  beforeAll(async () => {
    f = await startPgFixture();
    ids.memo = await seed(U1, T1, "a".repeat(64), "Nocturne planning memo");
    ids.notes = await seed(U1, T1, "b".repeat(64), "Meeting notes");
    ids.other = await seed(U1B, T1, "c".repeat(64), "Nocturne of a colleague");
    ids.foreign = await seed(
      "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1",
      T2,
      "d".repeat(64),
      "Nocturne of another tenant",
    );
    const summary = {
      tldr: "Plan for Q3.",
      keyPoints: ["Revenue"],
      entities: [],
      topics: [],
      suggestedQuestions: [],
    };
    await f.db.owner.query("UPDATE documents SET summary_enc = $1::jsonb WHERE id = $2", [
      JSON.stringify(await f.fields.forUser(U1).seal(summaryBind(ids.memo as string), summary)),
      ids.memo,
    ]);
    reads = new PgDocumentReads(f.app, f.fields, {
      async forPage(_who, docs) {
        asked.push(docs.map((d) => d.id));
        return new Map(docs.map((d) => [d.id, { ...UPLOADED, status: "ready" as const }]));
      },
    });
  });
  afterAll(async () => {
    await f?.close();
  });

  const scope = { tenantId: T1, ownerId: U1 };

  it("reads the owner's summary and title, and null stats for a document the ingest has not analysed", async () => {
    const v = await reads.summary(scope, ids.memo as string);
    expect(v).toMatchObject({
      title: "Nocturne planning memo",
      summary: { tldr: "Plan for Q3." },
      stats: null,
    });
  });

  it("answers null for a colleague's document, another tenant's, and an unknown id", async () => {
    for (const id of [ids.other, ids.foreign, "00000000-0000-4000-8000-000000000000"]) {
      expect(await reads.summary(scope, id as string)).toBeNull();
    }
  });

  it("lists only the owner's documents, newest first, with their status", async () => {
    const out = await reads.list(scope, { limit: 20 });
    expect(out.map((d) => d.documentId)).toEqual([ids.notes, ids.memo]);
    expect(out.every((d) => d.status === "ready")).toBe(true);
  });

  it("filters by title after decryption (case-insensitive), by scope, and by limit", async () => {
    expect(
      (await reads.list(scope, { titleContains: "NOCTURNE", limit: 20 })).map((d) => d.documentId),
    ).toEqual([ids.memo]);
    expect(
      (await reads.list(scope, { documentIds: [ids.notes as string], limit: 20 })).map(
        (d) => d.documentId,
      ),
    ).toEqual([ids.notes]);
    expect(await reads.list(scope, { limit: 1 })).toHaveLength(1);
  });

  it("asks the status model only about the documents it returns", async () => {
    asked.length = 0;
    await reads.list(scope, { titleContains: "notes", limit: 20 });
    expect(asked).toEqual([[ids.notes]]);
  });
});
