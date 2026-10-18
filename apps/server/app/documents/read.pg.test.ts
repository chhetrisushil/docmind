import type { DocumentDto, ListDocumentsResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type DocumentHarness, PDF, TEXT, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)("reading documents (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  const mine: string[] = [];

  const get = (path: string, user = "alice") =>
    fetch(`${h.base}${path}`, { headers: { "x-test-user": user } });

  beforeAll(async () => {
    h = await startDocumentServer();
    for (let i = 0; i < 5; i++) {
      const res = await h.upload("alice", `doc ${i}.txt`, TEXT(String(i)));
      mine.push(((await res.json()) as { document: DocumentDto }).document.id);
    }
    await h.upload("alice2", "colleague.txt", TEXT("colleague")); // same tenant, other user
    await h.upload("bob", "other tenant.txt", TEXT("bob"));
  });
  afterAll(async () => {
    await h?.close();
  });

  it("lists only the caller's documents, newest first, across pages without gaps or repeats", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(`/api/documents?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      const page = (await res.json()) as ListDocumentsResponse;
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((d) => d.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...mine].sort());
    const expected = await h.owner.query(
      "SELECT id FROM documents WHERE owner_id = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1' ORDER BY created_at DESC, id DESC",
    );
    expect(seen).toEqual(expected.rows.map((r) => r.id));
  });

  it("returns decrypted titles and a null cursor on the last page", async () => {
    const res = await get("/api/documents");
    const page = (await res.json()) as ListDocumentsResponse;
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((d) => d.title).sort()).toEqual([
      "doc 0",
      "doc 1",
      "doc 2",
      "doc 3",
      "doc 4",
    ]);
  });

  it("returns an empty list for a user with nothing", async () => {
    await h.owner.query(
      "DELETE FROM documents WHERE owner_id = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2'",
    );
    const page = (await (await get("/api/documents", "alice2")).json()) as ListDocumentsResponse;
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it("rejects a bad limit or cursor with 400", async () => {
    expect((await get("/api/documents?limit=0")).status).toBe(400);
    expect((await get("/api/documents?limit=101")).status).toBe(400);
    expect((await get("/api/documents?limit=abc")).status).toBe(400);
    const bad = await get("/api/documents?cursor=bm90IGEgY3Vyc29y");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_cursor");
    // Well-formed JSON, impossible date: 400, not a database error.
    const enc = Buffer.from(
      JSON.stringify({ t: "2026-13-45T10:20:30.123456Z", i: mine[0] }),
    ).toString("base64url");
    expect((await get(`/api/documents?cursor=${enc}`)).status).toBe(400);
    // Year 0000 round-trips in JS but Postgres rejects it.
    const year0 = Buffer.from(
      JSON.stringify({ t: "0000-01-01T00:00:00.000000Z", i: mine[0] }),
    ).toString("base64url");
    const zero = await get(`/api/documents?cursor=${year0}`);
    expect(zero.status).toBe(400);
    expect(((await zero.json()) as { error: { code: string } }).error.code).toBe("invalid_cursor");
  });

  it("a foreign document's keyset as cursor cannot reveal other users' documents", async () => {
    const colleague = (
      await h.owner.query<{ id: string; c: string }>(
        `SELECT id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS c
           FROM documents WHERE owner_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'`,
      )
    ).rows[0];
    const cursor = Buffer.from(
      JSON.stringify({ t: "9999-01-01T00:00:00.000000Z", i: colleague?.id }),
    ).toString("base64url");
    const page = (await (
      await get(`/api/documents?limit=100&cursor=${cursor}`)
    ).json()) as ListDocumentsResponse;
    expect(page.items.map((d) => d.id).sort()).toEqual([...mine].sort());
  });

  it("gets one document, and answers the same 404 for missing, foreign and malformed ids", async () => {
    const ok = await get(`/api/documents/${mine[0]}`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as DocumentDto).id).toBe(mine[0]);

    const bobsId = (
      await h.owner.query(
        "SELECT id FROM documents WHERE owner_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'",
      )
    ).rows[0].id as string;
    const missing = await get("/api/documents/00000000-0000-4000-8000-000000000000");
    const otherTenant = await get(`/api/documents/${bobsId}`);
    const malformed = await get("/api/documents/not-a-uuid");
    for (const res of [missing, otherTenant, malformed]) expect(res.status).toBe(404);
    const missingBody = await missing.text();
    expect(await otherTenant.text()).toBe(missingBody);
    expect(await malformed.text()).toBe(missingBody);
  });

  it("accepts an uppercase id and returns the canonical lowercase one", async () => {
    const res = await get(`/api/documents/${(mine[0] as string).toUpperCase()}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as DocumentDto).id).toBe(mine[0]);
  });

  it("requires a session on both routes", async () => {
    expect((await fetch(`${h.base}/api/documents`)).status).toBe(401);
    expect((await fetch(`${h.base}/api/documents/${mine[0]}`)).status).toBe(401);
  });

  it("shows a colleague's document to neither route", async () => {
    const res = await h.upload("alice2", "private.pdf", PDF("mine"));
    const id = ((await res.json()) as { document: DocumentDto }).document.id;
    expect((await get(`/api/documents/${id}`, "alice")).status).toBe(404);
    const list = (await (await get("/api/documents?limit=100")).json()) as ListDocumentsResponse;
    expect(list.items.map((d) => d.id)).not.toContain(id);
  });
});
