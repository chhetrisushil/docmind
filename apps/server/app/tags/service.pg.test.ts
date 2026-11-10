import { randomUUID } from "node:crypto";
import { MAX_TAGS_PER_USER } from "@docmind/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FieldKeyUnavailableError } from "../crypto/fields";
import { TagKeys } from "../crypto/tagKeys";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { insertDocument } from "../documents/repo";
import { T1, T2, U1, U1B, U2, newDocument } from "../documents/testHarness";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { TagExistsError, TagLimitError, TagService, UnknownTagError } from "./service";

const A = { tenantId: T1, userId: U1 };
const A2 = { tenantId: T1, userId: U1B };
const B = { tenantId: T2, userId: U2 };

describe.skipIf(!PG_URL)("TagService (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  let svc: TagService;
  let n = 0;
  const doc = async (who = A) => {
    const d = await newDocument(
      fx.fields,
      who.tenantId,
      who.userId,
      (++n).toString(16).padStart(64, "0"),
    );
    await withTenant(fx.app, who.tenantId, (tx) => insertDocument(tx, d));
    return d.id;
  };
  /** A user of tenant 1 that a test may erase or shred without disturbing the others. */
  const freshUser = async () => {
    const userId = randomUUID();
    await fx.db.owner.query(
      "INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, 'x')",
      [userId, T1, `${userId}@example.com`],
    );
    return { tenantId: T1, userId };
  };
  const count = async (sql: string, args: unknown[] = []) =>
    (await fx.db.owner.query(sql, args)).rows[0].n as number;
  /** Links the document to a tag by name and answers that tag (no non-null assertions: the lint rule forbids them). */
  const tagOf = async (who: typeof A, documentId: string, name: string) => {
    const added = await svc.addToDocument(who, documentId, name);
    const tag = added?.tags.find((t) => t.name === name);
    if (!tag) throw new Error("the tag was not added");
    return tag;
  };

  beforeAll(async () => {
    fx = await startPgFixture();
    svc = new TagService(fx.app, fx.fields, new TagKeys(fx.keys));
  });
  afterAll(async () => void (await fx?.close()));
  beforeEach(async () => {
    await fx.db.owner.query("DELETE FROM tags");
    await fx.db.owner.query("DELETE FROM documents");
  });

  it("reuses the tag for any spelling of the same normalised name, per owner", async () => {
    const first = await svc.create(A, "Q3 Report");
    const again = await svc.create(A, "  q3   REPORT ");
    expect(again).toEqual({ tag: first.tag, created: false });
    expect(first.created).toBe(true);
    expect(first.tag.name).toBe("Q3 Report"); // the display name is kept as first typed
    const other = await svc.create(A2, "Q3 Report"); // another user of the same tenant
    expect(other.tag.id).not.toBe(first.tag.id);
    expect(other.created).toBe(true);
  });

  it("enforces name_bind uniqueness in the database", async () => {
    await svc.create(A, "dup");
    const row = (await fx.db.owner.query("SELECT * FROM tags WHERE owner_id = $1", [U1])).rows[0];
    await expect(
      fx.db.owner.query(
        "INSERT INTO tags (id, tenant_id, owner_id, name_enc, name_bind) VALUES ($1, $2, $3, '{}', $4)",
        [randomUUID(), T1, U1, row.name_bind],
      ),
    ).rejects.toThrow(/tags_owner_name_key/);
  });

  it("seals the name: no plaintext in any column", async () => {
    await svc.create(A, "Zebra-Secret-Tag");
    const row = (await fx.db.owner.query("SELECT to_jsonb(t) AS r FROM tags t")).rows[0].r;
    expect(JSON.stringify(row)).not.toContain("Zebra");
  });

  it("lists with counts, sorted by name, and opens only the caller's tags", async () => {
    const d = await doc();
    await svc.addToDocument(A, d, "banana");
    await svc.addToDocument(A, d, "Apple");
    await svc.create(A, "cherry");
    await svc.create(A2, "other user");
    expect(await svc.list(A)).toEqual([
      { id: expect.any(String), name: "Apple", documents: 1 },
      { id: expect.any(String), name: "banana", documents: 1 },
      { id: expect.any(String), name: "cherry", documents: 0 },
    ]);
  });

  it("guarantees the document and the tag share the owner", async () => {
    const d = await doc(A);
    const foreign = (await svc.create(A2, "theirs")).tag.id;
    await expect(
      fx.db.owner.query(
        "INSERT INTO document_tags (document_id, tag_id, tenant_id, owner_id) VALUES ($1, $2, $3, $4)",
        [d, foreign, T1, U1],
      ),
    ).rejects.toThrow(/document_tags_tag_fkey/);
    await expect(svc.setForDocument(A, d, [foreign])).rejects.toBeInstanceOf(UnknownTagError);
    expect(await svc.setForDocument(A, randomUUID(), [])).toBeNull();
  });

  it("isolates tenants with row-level security", async () => {
    await svc.create(A, "visible to a1 only");
    const seen = await withTenant(
      fx.app,
      T2,
      async (tx) => (await tx.query("SELECT count(*)::int AS n FROM tags")).rows[0].n,
    );
    expect(seen).toBe(0);
    expect(await svc.list(B)).toEqual([]);
  });

  it("cascades: a deleted document drops its links and suggestions, a deleted tag its links, a deleted user everything", async () => {
    const d1 = await doc();
    const d2 = await doc();
    const t = await tagOf(A, d1, "keep");
    await svc.addToDocument(A, d2, "keep");
    await svc.putSuggestions({ ...A, documentId: d1 }, ["s1"]);
    await fx.db.owner.query("DELETE FROM documents WHERE id = $1", [d1]);
    expect(
      await count("SELECT count(*)::int AS n FROM document_tags WHERE document_id = $1", [d1]),
    ).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM document_tag_suggestions")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM tags WHERE id = $1", [t.id])).toBe(1); // a tag with no documents stays
    expect(await svc.remove(A, t.id)).toBe(true);
    expect(await count("SELECT count(*)::int AS n FROM document_tags")).toBe(0);
    const gone = await freshUser();
    await svc.addToDocument(gone, await doc(gone), "mine");
    await svc.putSuggestions({ ...gone, documentId: await doc(gone) }, ["s"]);
    await fx.db.owner.query("DELETE FROM users WHERE id = $1", [gone.userId]); // erasure's `rows` step
    for (const table of ["tags", "document_tags", "document_tag_suggestions"])
      expect(
        await count(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id = $1`, [gone.userId]),
      ).toBe(0);
  });

  it("crypto-shredding: once the key is destroyed the names cannot be opened", async () => {
    const who = await freshUser();
    await svc.create(who, "shredme");
    await fx.keys.destroy(who.userId);
    await expect(svc.list(who)).rejects.toBeInstanceOf(FieldKeyUnavailableError);
    await expect(svc.create(who, "again")).rejects.toBeInstanceOf(FieldKeyUnavailableError);
  });

  it("limits a document to 20 tags and a user to 200", async () => {
    const d = await doc();
    for (let i = 0; i < 20; i++) await svc.addToDocument(A, d, `t${i}`);
    await expect(svc.addToDocument(A, d, "t20")).rejects.toMatchObject({ limit: "document" });
    await svc.addToDocument(A, d, "t3"); // already linked: not a 21st
    await fx.db.owner.query(
      `INSERT INTO tags (id, tenant_id, owner_id, name_enc, name_bind)
       SELECT gen_random_uuid(), $1, $2, '{}', decode(md5(g::text) || md5(g::text || 'x'), 'hex')
         FROM generate_series(1, $3) g`,
      [T1, U1, MAX_TAGS_PER_USER - 20],
    );
    await expect(svc.create(A, "one too many")).rejects.toBeInstanceOf(TagLimitError);
    expect((await svc.create(A, "t3")).created).toBe(false); // reusing is not creating
  });

  it("renames, refuses a collision with 409's error, and allows a case-only change", async () => {
    const a = (await svc.create(A, "alpha")).tag;
    const b = (await svc.create(A, "beta")).tag;
    await expect(svc.rename(A, b.id, " ALPHA ")).rejects.toBeInstanceOf(TagExistsError);
    expect(await svc.rename(A, a.id, "ALPHA")).toEqual({ id: a.id, name: "ALPHA" });
    expect(await svc.rename(A, randomUUID(), "x")).toBeNull();
    expect(await svc.rename(A2, a.id, "x")).toBeNull(); // another user's tag
  });

  it("sets, adds and removes a document's tags, and reports the open suggestions without the linked ones", async () => {
    const d = await doc();
    const x = (await svc.create(A, "x")).tag;
    const y = (await svc.create(A, "y")).tag;
    expect((await svc.setForDocument(A, d, [x.id, y.id, x.id]))?.tags.map((t) => t.name)).toEqual([
      "x",
      "y",
    ]);
    await svc.putSuggestions({ ...A, documentId: d }, ["X", "fresh"]);
    expect((await svc.detail(A, d))?.suggestedTags).toEqual(["fresh"]); // "X" is linked as "x"
    expect((await svc.removeFromDocument(A, d, x.id))?.tags.map((t) => t.name)).toEqual(["y"]);
    expect((await svc.detail(A, d))?.suggestedTags).toEqual(["X", "fresh"]);
    expect(await svc.removeFromDocument(A, randomUUID(), x.id)).toBeNull();
  });

  it("accepts a suggestion (creating or reusing the tag) and dismisses one", async () => {
    const d = await doc();
    await svc.putSuggestions({ ...A, documentId: d }, ["Finance", "Legal", "Misc"]);
    const accepted = await svc.accept(A, d, "finance");
    expect(accepted?.tags.map((t) => t.name)).toEqual(["finance"]);
    expect(accepted?.suggestedTags).toEqual(["Legal", "Misc"]);
    expect((await svc.dismiss(A, d, "LEGAL"))?.suggestedTags).toEqual(["Misc"]);
    expect((await svc.dismiss(A, d, "Misc"))?.suggestedTags).toEqual([]);
    expect(await count("SELECT count(*)::int AS n FROM document_tag_suggestions")).toBe(0); // an empty list is no row
  });

  it("stores suggestions sealed, replaces the row, and reports a gone document", async () => {
    const d = await doc();
    expect(await svc.putSuggestions({ ...A, documentId: d }, ["Zebra-Secret-Suggestion"])).toBe(
      true,
    );
    expect(await svc.putSuggestions({ ...A, documentId: d }, ["second"])).toBe(true);
    const row = (await fx.db.owner.query("SELECT to_jsonb(s) AS r FROM document_tag_suggestions s"))
      .rows;
    expect(row).toHaveLength(1);
    expect(JSON.stringify(row)).not.toContain("Zebra");
    expect((await svc.detail(A, d))?.suggestedTags).toEqual(["second"]);
    expect(await svc.putSuggestions({ ...A, documentId: randomUUID() }, ["x"])).toBe(false);
    expect(await svc.putSuggestions({ ...A2, documentId: d }, ["x"])).toBe(false); // not their document
  });

  it("orders the suggestion context by use count, then name, and marks the tags the document has", async () => {
    const d1 = await doc();
    const d2 = await doc();
    await svc.addToDocument(A, d1, "popular");
    await svc.addToDocument(A, d2, "popular");
    await svc.addToDocument(A, d1, "alpha");
    await svc.create(A, "beta");
    const context = await svc.suggestionContext({ ...A, documentId: d1 });
    expect(context?.map((t) => [t.name, t.linked])).toEqual([
      ["popular", true],
      ["alpha", true],
      ["beta", false],
    ]);
    expect(await svc.suggestionContext({ ...A, documentId: randomUUID() })).toBeNull();
  });

  it("lists a page of documents' tags in one read", async () => {
    const d1 = await doc();
    const d2 = await doc();
    await svc.addToDocument(A, d1, "one");
    const map = await svc.forDocuments(A, [d1, d2]);
    expect(map.get(d1)?.map((t) => t.name)).toEqual(["one"]);
    expect(map.get(d2)).toBeUndefined();
  });
});
