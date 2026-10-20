import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenant } from "../../db/tenant";
import { PG_URL } from "../../db/testSupport";
import { insertDocument } from "../../documents/repo";
import { T1, T2, U1, U1B, U2, newDocument } from "../../documents/testHarness";
import { chunkIdFor } from "../../flows/ingest-document/chunker";
import { entityNameBind } from "../../flows/ingest-document/pgEntities";
import { type PgFixture, startPgFixture } from "../../flows/ingest-document/pgFixture";
import type { LinkKind } from "../../flows/ingest-document/pgLinks";
import { LinkReader } from "./links";

describe.skipIf(!PG_URL)("LinkReader (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  let reader: LinkReader;
  const A = { tenantId: T1, ownerId: U1 };
  const docs = new Map<string, string>();
  const ch = (name: string, ordinal: number) => chunkIdFor(docs.get(name) as string, ordinal);

  async function seedDoc(name: string, tenant: string, user: string, chunks: number) {
    const d = await newDocument(fx.fields, tenant, user, String(docs.size + 1).repeat(64));
    await withTenant(fx.app, tenant, (tx) => insertDocument(tx, d));
    docs.set(name, d.id);
    for (let i = 0; i < chunks; i++) {
      await fx.db.owner.query(
        `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
         VALUES ($1, $2, $3, $4, 0, '{"x":1}', '{"kind":"section","index":0}', 1)`,
        [chunkIdFor(d.id, i), tenant, d.id, i],
      );
    }
  }
  /** One direction, as the owner role: it can write the cross-owner rows the store refuses to. */
  const link = (src: string, dst: string, weight: number, kind: LinkKind = "similar") =>
    fx.db.owner.query(
      "INSERT INTO chunk_links (tenant_id, src_chunk_id, dst_chunk_id, kind, weight) VALUES ($1, $2, $3, $4, $5)",
      [T1, src, dst, kind, weight],
    );
  const entity = async (name: string, chunks: string[], user = U1) => {
    const id = randomUUID();
    await fx.db.owner.query(
      "INSERT INTO entities (id, tenant_id, owner_id, kind, name_enc, name_key) VALUES ($1, $2, $3, 'organization', $4::jsonb, $5)",
      [
        id,
        T1,
        user,
        JSON.stringify(await fx.fields.forUser(user).seal(entityNameBind(id), name)),
        randomUUID().replaceAll("-", "").repeat(2),
      ],
    );
    for (const c of chunks) {
      await fx.db.owner.query(
        "INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id) VALUES ($1, $2, $3)",
        [T1, c, id],
      );
    }
    return id;
  };

  beforeAll(async () => {
    fx = await startPgFixture();
    reader = new LinkReader(fx.app, fx.fields);
    await seedDoc("a", T1, U1, 8);
    await seedDoc("b", T1, U1, 8);
    await seedDoc("c", T1, U1, 3);
    await seedDoc("theirs", T1, U1B, 2);
  });
  afterAll(async () => {
    await fx?.close();
  });
  beforeEach(async () => {
    await fx.db.owner.query("DELETE FROM chunk_links");
    await fx.db.owner.query("DELETE FROM entities");
  });

  it("returns each source's strongest links, capped per source by a window, strongest first", async () => {
    for (let i = 1; i <= 6; i++) await link(ch("a", 0), ch("b", i), i / 10);
    for (let i = 1; i <= 3; i++) await link(ch("a", 1), ch("b", i), 0.9 - i / 10);
    const got = await reader.from(A, [ch("a", 1), ch("a", 0)], { perChunk: 4 });
    expect(got.map((h) => [h.src, h.dst, h.weight])).toEqual([
      [ch("a", 1), ch("b", 1), 0.8],
      [ch("a", 1), ch("b", 2), 0.7],
      [ch("a", 1), ch("b", 3), 0.6],
      [ch("a", 0), ch("b", 6), 0.6],
      [ch("a", 0), ch("b", 5), 0.5],
      [ch("a", 0), ch("b", 4), 0.4],
      [ch("a", 0), ch("b", 3), 0.3],
    ]);
    expect(got.every((h) => h.entity === undefined)).toBe(true);
  });

  it("filters by kind and by target document before the cap, so the fan-out comes from inside the scope", async () => {
    await link(ch("a", 0), ch("b", 0), 0.95, "reference");
    await link(ch("a", 0), ch("b", 1), 0.9, "similar");
    await link(ch("a", 0), ch("c", 0), 0.2, "similar");
    await link(ch("a", 0), ch("c", 1), 0.1, "structure");
    const only = (kinds: LinkKind[]) => reader.from(A, [ch("a", 0)], { perChunk: 1, kinds });
    expect((await only(["similar"]))[0]?.dst).toBe(ch("b", 1));
    expect((await only(["structure", "reference"]))[0]?.dst).toBe(ch("b", 0));
    const inC = await reader.from(A, [ch("a", 0)], {
      perChunk: 1,
      documentIds: [docs.get("c") as string],
    });
    expect(inC.map((h) => h.dst)).toEqual([ch("c", 0)]); // the strongest link INSIDE c, not the strongest overall
    expect(await reader.from(A, [ch("a", 0)], { perChunk: 4, kinds: [] })).toEqual([]);
    expect(await reader.from(A, [ch("a", 0)], { perChunk: 4, documentIds: [] })).toEqual([]);
  });

  it("owner-scopes both ends: a link into or out of another user's chunk is invisible", async () => {
    await link(ch("a", 0), ch("theirs", 0), 0.99); // into another user's chunk (same tenant)
    await link(ch("theirs", 1), ch("a", 1), 0.99); // out of another user's chunk
    await link(ch("a", 0), ch("b", 0), 0.1);
    expect((await reader.from(A, [ch("a", 0)], { perChunk: 4 })).map((h) => h.dst)).toEqual([
      ch("b", 0),
    ]);
    expect(await reader.from(A, [ch("theirs", 1)], { perChunk: 4 })).toEqual([]);
    expect(await reader.from({ tenantId: T2, ownerId: U2 }, [ch("a", 0)], { perChunk: 4 })).toEqual(
      [],
    );
    expect(
      (await reader.from({ tenantId: T1, ownerId: U1B }, [ch("theirs", 1)], { perChunk: 4 })).map(
        (h) => h.dst,
      ),
    ).toEqual([]);
  });

  it("names the rarest shared entity for an entity link, and only for an entity link", async () => {
    await link(ch("a", 0), ch("b", 0), 0.6, "entity");
    await link(ch("a", 0), ch("b", 1), 0.5, "similar");
    await entity("Common Corp", [ch("a", 0), ch("b", 0), ch("b", 2), ch("b", 3)]);
    await entity("Rare Holdings Ltd", [ch("a", 0), ch("b", 0)]);
    await entity("Only In A", [ch("a", 0)]);
    const got = await reader.from(A, [ch("a", 0)], { perChunk: 4 });
    expect(got.map((h) => [h.kind, h.entity])).toEqual([
      ["entity", "Rare Holdings Ltd"],
      ["similar", undefined],
    ]);
  });

  it("gives an entity link with no shared entity row no name, and ignores another owner's entity", async () => {
    await link(ch("a", 0), ch("b", 0), 0.6, "entity");
    await entity("Theirs Inc", [ch("a", 0), ch("b", 0)], U1B);
    expect((await reader.from(A, [ch("a", 0)], { perChunk: 4 }))[0]).toEqual({
      src: ch("a", 0),
      dst: ch("b", 0),
      kind: "entity",
      weight: 0.6,
    });
  });

  it("refuses a bad perChunk or too many sources, ignores malformed ids, and answers [] for no sources", async () => {
    for (const n of [0, 25, 1.5, Number.NaN]) {
      await expect(reader.from(A, [ch("a", 0)], { perChunk: n })).rejects.toThrow(
        /^from: perChunk must be an integer from 1 to 24$/,
      );
    }
    const many = Array.from({ length: 65 }, () => randomUUID());
    await expect(reader.from(A, many, { perChunk: 4 })).rejects.toThrow(
      /^from: at most 64 source ids$/,
    );
    await link(ch("a", 0), ch("b", 0), 0.5);
    expect(
      (await reader.from(A, ["nope", ch("a", 0).toUpperCase()], { perChunk: 4 })).map((h) => h.dst),
    ).toEqual([ch("b", 0)]);
    expect(await reader.from(A, [], { perChunk: 4 })).toEqual([]);
  });
});
