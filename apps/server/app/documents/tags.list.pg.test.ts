import { type DocumentDto, ListDocumentsResponse } from "@docmind/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { PG_URL } from "../db/testSupport";
import { ALICE, ALICE2, type DocumentHarness, seedDoc, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)("GET /api/documents with a tag filter (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  let docs: string[]; // d1 is the newest
  let tag: Record<"a" | "b" | "c", string>;
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => void (await h?.close()));
  beforeEach(async () => {
    await h.owner.query("DELETE FROM tags");
    await h.owner.query("DELETE FROM documents");
    const fields = new FieldCrypto(h.keys);
    docs = [];
    for (let i = 0; i < 7; i++)
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
    const mk = async (name: string) => (await h.tags.create(ALICE, name)).tag.id;
    tag = { a: await mk("a"), b: await mk("b"), c: await mk("c") };
    const link = (name: "a" | "b" | "c", idx: number[]) =>
      Promise.all(
        idx.map((i) =>
          h.owner.query(
            "INSERT INTO document_tags (document_id, tag_id, tenant_id, owner_id) SELECT $1, $2, tenant_id, owner_id FROM documents WHERE id = $1",
            [docs[i], tag[name]],
          ),
        ),
      );
    await link("a", [0, 1, 2, 4]);
    await link("b", [1, 2, 3]);
    await link("c", [2]);
  });
  const get = (user: string, qs: string) =>
    fetch(`${h.base}/api/documents?${qs}`, { headers: { "x-test-user": user } });
  const ids = async (res: Response) =>
    (ListDocumentsResponse.parse(await res.json()).items as DocumentDto[]).map((d) => d.id);
  const at = (...i: number[]) => i.map((x) => docs[x]);

  it("any: a document with at least one of the tags; all: with every one; newest first", async () => {
    expect(await ids(await get("alice", `tags=${tag.a},${tag.b}`))).toEqual(at(0, 1, 2, 3, 4));
    expect(await ids(await get("alice", `tags=${tag.a},${tag.b}&match=any`))).toEqual(
      at(0, 1, 2, 3, 4),
    );
    expect(await ids(await get("alice", `tags=${tag.a},${tag.b}&match=all`))).toEqual(at(1, 2));
    expect(await ids(await get("alice", `tags=${tag.a},${tag.b},${tag.c}&match=all`))).toEqual(
      at(2),
    );
    expect(await ids(await get("alice", `tags=${tag.a}&match=all`))).toEqual(at(0, 1, 2, 4)); // one tag: same as any
    expect(await ids(await get("alice", "match=all"))).toHaveLength(7); // no tags: unfiltered, match ignored
    expect(await ids(await get("alice", "tags="))).toHaveLength(7);
  });

  it("pages with no duplicate and no gap in both modes", async () => {
    for (const [qs, want] of [
      [`tags=${tag.a},${tag.b}`, at(0, 1, 2, 3, 4)],
      [`tags=${tag.a},${tag.b}&match=all`, at(1, 2)],
      ["", docs],
    ] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const res: Response = await get(
          "alice",
          `${qs}&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        );
        const page = ListDocumentsResponse.parse(await res.json());
        seen.push(...page.items.map((d) => d.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(want);
    }
  });

  it("answers 400 invalid_cursor when a cursor is reused under a changed filter, and accepts the same filter", async () => {
    const first = ListDocumentsResponse.parse(
      await (await get("alice", `tags=${tag.a}&limit=1`)).json(),
    );
    const cursor = first.nextCursor as string;
    for (const qs of [
      `tags=${tag.b}`,
      `tags=${tag.a},${tag.b}`,
      "",
      `tags=${tag.a},${tag.b}&match=all`,
    ]) {
      const res = await get("alice", `${qs}&limit=1&cursor=${cursor}`);
      expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([
        400,
        "invalid_cursor",
      ]);
    }
    expect((await get("alice", `tags=${tag.a}&match=all&limit=1&cursor=${cursor}`)).status).toBe(
      200,
    ); // one tag: same filter
    const plain = ListDocumentsResponse.parse(await (await get("alice", "limit=1")).json());
    expect((await get("alice", `tags=${tag.a}&limit=1&cursor=${plain.nextCursor}`)).status).toBe(
      400,
    );
  });

  it("refuses a malformed filter with 400 invalid_request", async () => {
    const eleven = Array.from(
      { length: 11 },
      (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    ).join(",");
    for (const qs of ["tags=nope", `tags=${eleven}`, `tags=${tag.a}&match=some`]) {
      const res = await get("alice", qs);
      expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([
        400,
        "invalid_request",
      ]);
    }
  });

  it("never shows another user's documents, even for a tag id that is not theirs", async () => {
    expect(await ids(await get("alice2", `tags=${tag.a}`))).toEqual([]);
    expect(await ids(await get("bob", `tags=${tag.a}&match=all`))).toEqual([]);
    await seedDoc(h.owner, h.app, new FieldCrypto(h.keys), ALICE2, "f".repeat(64), 1);
    expect(await ids(await get("alice2", ""))).toHaveLength(1);
  });
});
