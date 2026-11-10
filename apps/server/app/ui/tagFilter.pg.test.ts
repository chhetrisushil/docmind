import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { PG_URL } from "../db/testSupport";
import {
  ALICE,
  type DocumentHarness,
  seedDoc,
  startDocumentServer,
} from "../documents/testHarness";
import { readersFor } from "./readers";

describe.skipIf(!PG_URL)("the library reader with a tag filter (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  let docs: string[];
  let tag: { a: string; b: string };
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => void (await h?.close()));
  beforeEach(async () => {
    await h.owner.query("DELETE FROM tags");
    await h.owner.query("DELETE FROM documents");
    const fields = new FieldCrypto(h.keys);
    docs = [];
    for (let i = 0; i < 4; i++)
      docs.push(
        await seedDoc(
          h.owner,
          h.app,
          fields,
          ALICE,
          (i + 1).toString(16).padStart(64, "0"),
          (i + 1) * 10,
        ),
      );
    tag = {
      a: (await h.tags.create(ALICE, "a")).tag.id,
      b: (await h.tags.create(ALICE, "b")).tag.id,
    };
    await h.tags.setForDocument(ALICE, docs[0] as string, [tag.a]);
    await h.tags.setForDocument(ALICE, docs[1] as string, [tag.a, tag.b]);
    await h.tags.setForDocument(ALICE, docs[2] as string, [tag.b]);
  });
  const readers = () =>
    readersFor(
      { pool: h.app, fields: new FieldCrypto(h.keys), status: h.status, tags: h.tags } as never,
      ALICE,
    );
  const ids = async (a: {
    tags: string[];
    match: "any" | "all";
    status?: "all" | "processing" | "ready" | "failed";
  }) =>
    (
      await readers().documents({
        limit: 100,
        status: a.status ?? "all",
        tags: a.tags,
        match: a.match,
      })
    ).items.map((d) => d.id);

  it("filters in SQL by any or all, newest first, and carries each row's tags", async () => {
    expect(await ids({ tags: [tag.a, tag.b], match: "any" })).toEqual([docs[0], docs[1], docs[2]]);
    expect(await ids({ tags: [tag.a, tag.b], match: "all" })).toEqual([docs[1]]);
    expect(await ids({ tags: [], match: "all" })).toEqual(docs);
    const page = await readers().documents({
      limit: 100,
      status: "all",
      tags: [tag.a],
      match: "any",
    });
    expect(page.items.map((d) => d.tags.map((t) => t.name))).toEqual([["a"], ["a", "b"]]);
  });

  it("combines with the status filter and the limit (truncated says there were more matches)", async () => {
    expect(await ids({ tags: [tag.a], match: "any", status: "failed" })).toEqual([]);
    expect(await ids({ tags: [tag.a], match: "any", status: "processing" })).toEqual([
      docs[0],
      docs[1],
    ]); // seeded documents are queued
    const one = await readers().documents({ limit: 1, status: "all", tags: [tag.a], match: "any" });
    expect([one.items.length, one.truncated]).toEqual([1, true]);
  });
});
