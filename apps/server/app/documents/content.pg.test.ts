import { randomUUID } from "node:crypto";
import { DocumentContentResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { PG_URL } from "../db/testSupport";
import { type Chunk, chunkIdFor } from "../flows/ingest-document/chunker";
import { PgChunkStore } from "../flows/ingest-document/pgChunks";
import { CONTENT_PAGE, readContent } from "./content";
import {
  ALICE,
  ALICE2,
  BOB,
  type DocumentHarness,
  seedDoc,
  startDocumentServer,
} from "./testHarness";

describe.skipIf(!PG_URL)("document content (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  let fields: FieldCrypto;
  let mine: string;
  let empty: string;
  let theirs: string;
  let bobs: string;
  const chunk = (n: number): Chunk => ({
    ordinal: n,
    sectionOrdinal: Math.floor(n / 10),
    headingPath: ["Terms", `Clause ${n}`],
    text: `sentinel-clause-${n}-text-0123456789`,
    tokenCount: 8,
    locator: { kind: "page", page: n + 1 },
  });
  const get = (path: string, user = "alice") =>
    fetch(`${h.base}${path}`, { headers: user ? { "x-test-user": user } : {} });

  beforeAll(async () => {
    h = await startDocumentServer();
    fields = new FieldCrypto(h.keys);
    const seed = async (who: typeof ALICE, fp: string, n: number) => {
      const id = await seedDoc(h.owner, h.app, fields, who, fp.repeat(64), 10);
      await new PgChunkStore(h.app, fields).replace(
        { tenantId: who.tenantId, userId: who.userId, documentId: id },
        Array.from({ length: n }, (_, i) => chunk(i)),
      );
      return id;
    };
    mine = await seed(ALICE, "a", 45);
    empty = await seed(ALICE, "b", 0);
    theirs = await seed(ALICE2, "c", 3);
    bobs = await seed(BOB, "d", 3);
  });
  afterAll(async () => {
    await h?.close();
  });

  it("pages through every passage in reading order, 20 at a time, with no gaps or repeats", async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(`/api/documents/${mine}/content${cursor ? `?cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      const page = DocumentContentResponse.parse(await res.json());
      expect(page.items.length).toBeLessThanOrEqual(CONTENT_PAGE);
      seen.push(...page.items.map((p) => p.ordinal));
      for (const p of page.items) expect(p.passageId).toBe(chunkIdFor(mine, p.ordinal));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: 45 }, (_, i) => i));
  });

  it("returns the decrypted text, heading path and locator of a passage", async () => {
    const page = DocumentContentResponse.parse(
      await (await get(`/api/documents/${mine}/content`)).json(),
    );
    expect(page.items[3]).toMatchObject({
      ordinal: 3,
      headingPath: ["Terms", "Clause 3"],
      text: "sentinel-clause-3-text-0123456789",
      locator: { kind: "page", page: 4 },
    });
  });

  it("keeps the text sealed at rest", async () => {
    const { rows } = await h.owner.query(
      "SELECT text_enc::text AS raw FROM chunks WHERE document_id = $1 AND ordinal = 3",
      [mine],
    );
    expect(rows[0].raw).toContain("__loomEnc");
    expect(rows[0].raw).not.toContain("sentinel-clause-3");
  });

  it("answers an empty document with an empty page", async () => {
    expect(await (await get(`/api/documents/${empty}/content`)).json()).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("answers 404 alike for an unknown id, a malformed id, a colleague's document and another tenant's", async () => {
    const answers = await Promise.all(
      [randomUUID(), "not-a-uuid", theirs, bobs].map(async (id) => {
        const res = await get(`/api/documents/${id}/content`);
        return [res.status, await res.json()];
      }),
    );
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]?.[0]).toBe(404);
  });

  it("refuses a bad cursor with 400 and no session with 401", async () => {
    for (const c of ["x", "!!!", Buffer.from("o:-1").toString("base64url")]) {
      const res = await get(`/api/documents/${mine}/content?cursor=${c}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_cursor");
    }
    expect((await get(`/api/documents/${mine}/content`, "")).status).toBe(401);
  });

  it("a cursor cannot reach another document: the id in the path decides", async () => {
    const cursor = Buffer.from("o:0").toString("base64url");
    const res = await get(`/api/documents/${theirs}/content?cursor=${cursor}`);
    expect(res.status).toBe(404);
  });

  it("sends Cache-Control: no-store on the page and on the 404 and 400", async () => {
    for (const path of [
      `/api/documents/${mine}/content`,
      `/api/documents/${randomUUID()}/content`,
      `/api/documents/${mine}/content?cursor=x`,
    ])
      expect((await get(path)).headers.get("cache-control")).toBe("no-store");
  });

  it("reads nothing, not even a sealed row, once the user is erasing", async () => {
    const eve = { tenantId: ALICE.tenantId, userId: "e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0" };
    await h.owner.query(
      "INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, 'eve@example.com', 'x')",
      [eve.userId, eve.tenantId],
    );
    const id = await seedDoc(h.owner, h.app, fields, eve, "e".repeat(64), 10);
    await new PgChunkStore(h.app, fields).replace(
      { tenantId: eve.tenantId, userId: eve.userId, documentId: id },
      [chunk(0)],
    );
    expect((await readContent(h.app, fields, eve, id, -1))?.items).toHaveLength(1);
    await h.owner.query("UPDATE users SET erasing_at = now() WHERE id = $1", [eve.userId]);
    expect(await readContent(h.app, fields, eve, id, -1)).toBeNull();
  });

  it("logs no passage text", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    try {
      await get(`/api/documents/${mine}/content`);
      await get(`/api/documents/${mine}/content?cursor=x`);
      const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
      expect(logged).not.toContain("sentinel");
      expect(logged).not.toContain(mine);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
