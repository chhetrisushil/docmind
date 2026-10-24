import { randomUUID } from "node:crypto";
import { EncryptedFsContentStore } from "@docmind/blob-store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { chunkIdFor } from "../flows/ingest-document/chunker";
import { PgChunkStore } from "../flows/ingest-document/pgChunks";
import { insertDocument } from "./repo";
import { ALICE, BOB, type DocumentHarness, newDocument, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)("document source (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  let fields: FieldCrypto;
  const get = (path: string, user = "alice") =>
    fetch(`${h.base}${path}`, { headers: { "x-test-user": user } });

  // biome-ignore lint/suspicious/noExplicitAny: a test reads fields off an untyped body.
  const bodyOf = async (res: Response): Promise<any> => res.json();

  const upload = async (who: typeof ALICE, mime: string, text: string, fp: string) => {
    const store = new EncryptedFsContentStore({
      root: h.root,
      tenantId: who.tenantId,
      userId: who.userId,
      keys: h.keys,
      maxBytes: 4 << 20,
    });
    const bytes = new TextEncoder().encode(text);
    const ref = await store.put(bytes);
    const doc = await newDocument(fields, who.tenantId, who.userId, fp.repeat(64), {
      contentAddress: ref.__loomContent,
      mime,
      sizeBytes: bytes.length,
    });
    await withTenant(h.app, who.tenantId, (tx) => insertDocument(tx, doc));
    return doc.id;
  };

  beforeAll(async () => {
    h = await startDocumentServer();
    fields = new FieldCrypto(h.keys);
  });
  afterAll(() => h?.close());

  it("returns an owner's markdown source, no-store", async () => {
    const id = await upload(ALICE, "text/markdown", "# Title\n\nbody", "a");
    const res = await get(`/api/documents/${id}/source`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(res)).toEqual({ format: "md", text: "# Title\n\nbody", truncated: false });
  });

  it("maps org and txt", async () => {
    const org = await upload(ALICE, "text/x-org", "* H", "b");
    const txt = await upload(ALICE, "text/plain", "plain", "c");
    expect((await bodyOf(await get(`/api/documents/${org}/source`))).format).toBe("org");
    expect((await bodyOf(await get(`/api/documents/${txt}/source`))).format).toBe("txt");
  });

  it("answers 415 for a format it does not render", async () => {
    const id = await upload(ALICE, "application/pdf", "%PDF-1.7", "d");
    const res = await get(`/api/documents/${id}/source`);
    expect(res.status).toBe(415);
    expect((await bodyOf(res)).error.code).toBe("not_renderable");
  });

  it("is 404 for a missing, malformed or someone else's document", async () => {
    const bobs = await upload(BOB, "text/markdown", "secret", "e");
    for (const id of [randomUUID(), "not-a-uuid", bobs]) {
      const res = await get(`/api/documents/${id}/source`);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("is 401 without a session", async () => {
    const res = await fetch(`${h.base}/api/documents/${randomUUID()}/source`);
    expect(res.status).toBe(401);
  });

  it("cuts over SOURCE_MAX_CHARS on a line break", async () => {
    const id = await upload(ALICE, "text/plain", `${"a".repeat(999_990)}\n${"b".repeat(100)}`, "f");
    const body = await bodyOf(await get(`/api/documents/${id}/source`));
    expect(body.truncated).toBe(true);
    expect(body.text).toBe("a".repeat(999_990));
  });

  it("returns focus for a passage of this document, and ignores another's", async () => {
    const id = await upload(ALICE, "text/markdown", "# T\n\nalpha beta", "7");
    await new PgChunkStore(h.app, fields).replace(
      { tenantId: ALICE.tenantId, userId: ALICE.userId, documentId: id },
      [
        {
          ordinal: 0,
          sectionOrdinal: 0,
          headingPath: ["T"],
          text: "alpha beta",
          tokenCount: 2,
          locator: { kind: "chars", start: 5, end: 15 },
        },
      ],
    );
    const mine = chunkIdFor(id, 0);
    expect((await bodyOf(await get(`/api/documents/${id}/source?passage=${mine}`))).focus).toEqual({
      from: 5,
      to: 15,
    });
    const other = await upload(ALICE, "text/markdown", "x", "6");
    const body = await bodyOf(await get(`/api/documents/${other}/source?passage=${mine}`));
    expect(body.focus).toBeUndefined();
  });
});
