import { randomUUID } from "node:crypto";
import {
  type DocumentDto,
  DocumentTagsResponse,
  ListTagsResponse,
  TagResponse,
} from "@docmind/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import {
  ALICE,
  BOB,
  type DocumentHarness,
  callApi,
  errorCode as code,
  seedNext,
  startDocumentServer,
} from "../documents/testHarness";

describe.skipIf(!PG_URL)("tag routes (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => void (await h?.close()));
  beforeEach(async () => {
    await h.owner.query("DELETE FROM tags");
    await h.owner.query("DELETE FROM documents");
  });
  const call = (user: string | null, method: string, path: string, body?: unknown, type?: string) =>
    callApi(h, user, method, path, body, type);
  const seed = (who = ALICE) => seedNext(h, who);
  const mk = async (user: string, name: string) =>
    TagResponse.parse(await (await call(user, "POST", "/api/tags", { name })).json()).tag;

  it("answers 401 without a session on every method, and 413 for an oversized body", async () => {
    const d = await seed();
    for (const [method, path, body] of [
      ["POST", "/api/tags", { name: "a" }],
      ["PATCH", `/api/tags/${randomUUID()}`, { name: "a" }],
      ["DELETE", `/api/tags/${randomUUID()}`, undefined],
      ["PUT", `/api/documents/${d}/tags`, { tagIds: [] }],
      ["POST", `/api/documents/${d}/tags`, { name: "a" }],
      ["DELETE", `/api/documents/${d}/tags/${randomUUID()}`, undefined],
    ] as const)
      expect([method, (await call(null, method, path, body)).status]).toEqual([method, 401]);
    const big = await call("alice", "POST", "/api/tags", { name: "x".repeat(20 * 1024) });
    expect(big.status).toBe(413);
  });

  it("collapses duplicate ids in a set before the cap", async () => {
    const d = await seed();
    const t = await mk("alice", "one");
    const same = Array.from({ length: 21 }, () => t.id);
    const res = await call("alice", "PUT", `/api/documents/${d}/tags`, { tagIds: same });
    expect(DocumentTagsResponse.parse(await res.json()).tags).toEqual([t]);
  });

  it("needs a session, JSON, and a valid name", async () => {
    expect((await call(null, "GET", "/api/tags")).status).toBe(401);
    expect((await call("alice", "POST", "/api/tags", '{"name":"a"}', "text/plain")).status).toBe(
      415,
    );
    for (const name of ["", "   ", "x".repeat(41), "a\nb"]) {
      const res = await call("alice", "POST", "/api/tags", { name });
      expect([res.status, await code(res)]).toEqual([400, "invalid_request"]);
    }
    expect((await call("alice", "POST", "/api/tags", { name: "a", extra: 1 })).status).toBe(400);
  });

  it("creates with 201, reuses the same normalised name with 200, and never caches", async () => {
    const first = await call("alice", "POST", "/api/tags", { name: "Q3 Report" });
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const t = TagResponse.parse(await first.json()).tag;
    const again = await call("alice", "POST", "/api/tags", { name: " q3   REPORT " });
    expect([again.status, TagResponse.parse(await again.json()).tag]).toEqual([200, t]);
    expect((await mk("bob", "Q3 Report")).id).not.toBe(t.id); // per user
  });

  it("lists the caller's tags with document counts, sorted by name", async () => {
    const d = await seed();
    await call("alice", "POST", `/api/documents/${d}/tags`, { name: "banana" });
    await mk("alice", "Apple");
    await mk("bob", "bob-only");
    const res = await call("alice", "GET", "/api/tags");
    expect(ListTagsResponse.parse(await res.json()).tags.map((t) => [t.name, t.documents])).toEqual(
      [
        ["Apple", 0],
        ["banana", 1],
      ],
    );
  });

  it("renames, answers 409 tag_exists on a collision, and 404 for a foreign or malformed id", async () => {
    const a = await mk("alice", "alpha");
    const b = await mk("alice", "beta");
    const ok = await call("alice", "PATCH", `/api/tags/${a.id}`, { name: "Alpha 2" });
    expect([ok.status, TagResponse.parse(await ok.json()).tag]).toEqual([
      200,
      { id: a.id, name: "Alpha 2" },
    ]);
    const clash = await call("alice", "PATCH", `/api/tags/${b.id}`, { name: " ALPHA  2" });
    expect([clash.status, await code(clash)]).toEqual([409, "tag_exists"]);
    const foreign = await call("bob", "PATCH", `/api/tags/${a.id}`, { name: "x" });
    const unknown = await call("bob", "PATCH", `/api/tags/${randomUUID()}`, { name: "x" });
    expect([foreign.status, await foreign.text()]).toEqual([404, await unknown.text()]);
    expect((await call("alice", "PATCH", "/api/tags/not-a-uuid", { name: "x" })).status).toBe(404);
  });

  it("deletes a tag and its links; a foreign id is 404", async () => {
    const d = await seed();
    const t = await mk("alice", "gone");
    await call("alice", "PUT", `/api/documents/${d}/tags`, { tagIds: [t.id] });
    const foreign = await call("bob", "DELETE", `/api/tags/${t.id}`);
    const unknown = await call("bob", "DELETE", `/api/tags/${randomUUID()}`);
    expect([foreign.status, await foreign.text()]).toEqual([404, await unknown.text()]);
    expect((await call("alice", "DELETE", `/api/tags/${t.id}`)).status).toBe(204);
    expect((await h.owner.query("SELECT count(*)::int AS n FROM document_tags")).rows[0].n).toBe(0);
    expect((await call("alice", "DELETE", `/api/tags/${t.id}`)).status).toBe(404);
  });

  it("sets a document's tags: 400 invalid_tag for a foreign or unknown id, 404 for a document that is not yours, 400 over 20", async () => {
    const d = await seed();
    const mine = await mk("alice", "mine");
    const theirs = await mk("bob", "theirs");
    const ok = await call("alice", "PUT", `/api/documents/${d}/tags`, { tagIds: [mine.id] });
    expect(DocumentTagsResponse.parse(await ok.json()).tags).toEqual([mine]);
    for (const id of [theirs.id, randomUUID()]) {
      const bad = await call("alice", "PUT", `/api/documents/${d}/tags`, { tagIds: [id] });
      expect([bad.status, await code(bad)]).toEqual([400, "invalid_tag"]);
    }
    const bobDoc = await seed(BOB);
    expect(
      (await call("alice", "PUT", `/api/documents/${bobDoc}/tags`, { tagIds: [] })).status,
    ).toBe(404);
    const many = Array.from({ length: 21 }, () => randomUUID());
    expect((await call("alice", "PUT", `/api/documents/${d}/tags`, { tagIds: many })).status).toBe(
      400,
    );
  });

  it("answers 404 and creates nothing when adding to another user's document; a malformed tag id on removal is a no-op", async () => {
    const bobDoc = await seed(BOB);
    const res = await call("alice", "POST", `/api/documents/${bobDoc}/tags`, { name: "sneaky" });
    expect(res.status).toBe(404);
    expect((await h.owner.query("SELECT count(*)::int AS n FROM tags")).rows[0].n).toBe(0);
    const d = await seed();
    expect((await call("alice", "DELETE", `/api/documents/${d}/tags/not-a-uuid`)).status).toBe(200);
    expect((await call("alice", "DELETE", `/api/documents/${bobDoc}/tags/not-a-uuid`)).status).toBe(
      404,
    );
  });

  it("adds by name (creating or reusing), removes one, and refuses a 21st with 409 tag_limit", async () => {
    const d = await seed();
    const add = (name: string) => call("alice", "POST", `/api/documents/${d}/tags`, { name });
    const finance = DocumentTagsResponse.parse(await (await add("Finance")).json()).tags;
    expect(finance.map((t) => t.name)).toEqual(["Finance"]);
    expect(DocumentTagsResponse.parse(await (await add("finance")).json()).tags).toHaveLength(1);
    for (let i = 0; i < 19; i++) await add(`t${i}`);
    const over = await add("one more");
    expect([over.status, await code(over)]).toEqual([409, "tag_limit"]);
    const id = (finance[0] as { id: string }).id;
    const removed = await call("alice", "DELETE", `/api/documents/${d}/tags/${id}`);
    expect(DocumentTagsResponse.parse(await removed.json()).tags.map((t) => t.name)).not.toContain(
      "Finance",
    );
    expect((await call("bob", "DELETE", `/api/documents/${d}/tags/${id}`)).status).toBe(404);
  });

  it("puts tags on the list rows and tags with suggestedTags on the detail", async () => {
    const d = await seed();
    await call("alice", "POST", `/api/documents/${d}/tags`, { name: "one" });
    await h.tags.putSuggestions({ ...ALICE, documentId: d }, ["maybe"]);
    const detail = (await (
      await call("alice", "GET", `/api/documents/${d}`)
    ).json()) as DocumentDto;
    expect([detail.tags.map((t) => t.name), detail.suggestedTags]).toEqual([["one"], ["maybe"]]);
    const list = (await (await call("alice", "GET", "/api/documents")).json()) as {
      items: DocumentDto[];
    };
    expect(list.items[0]?.tags.map((t) => t.name)).toEqual(["one"]);
    expect(list.items[0]?.suggestedTags).toBeUndefined();
  });
});
