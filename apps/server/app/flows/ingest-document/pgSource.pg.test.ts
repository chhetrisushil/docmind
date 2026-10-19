import { randomUUID } from "node:crypto";
import { BlobCorruptError, BlobKeyUnavailableError } from "@docmind/blob-store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../../db/testSupport";
import { T2, U1B } from "../../documents/testHarness";
import { DocumentGoneError } from "./errors";
import { type PgFixture, startPgFixture } from "./pgFixture";
import { PgDocumentSource } from "./pgSource";

const addr = (c: string) => `hmac-sha256:${c.repeat(64)}`;

describe.skipIf(!PG_URL)("PgDocumentSource (needs DOCMIND_TEST_PG_URL)", () => {
  let f: PgFixture;
  beforeAll(async () => {
    f = await startPgFixture();
  });
  afterAll(async () => {
    await f?.close();
  });
  const none = () => ({ get: async () => null });
  const bytes = () => ({ get: async () => Uint8Array.of(1, 2) });

  it("meta returns the mime and the content address of the owner's document", async () => {
    const ref = await f.doc("6".repeat(64));
    expect(await new PgDocumentSource(f.app, none).meta(ref)).toEqual({
      mime: "application/pdf",
      contentAddress: addr("6"),
    });
  });

  it("meta throws DocumentGoneError for another owner's, another tenant's and a deleted document", async () => {
    const ref = await f.doc("7".repeat(64));
    const source = new PgDocumentSource(f.app, none);
    await expect(source.meta({ ...ref, userId: U1B })).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(source.meta({ ...ref, tenantId: T2 })).rejects.toBeInstanceOf(DocumentGoneError);
    await f.db.owner.query("DELETE FROM documents WHERE id = $1", [ref.documentId]);
    await expect(source.meta(ref)).rejects.toBeInstanceOf(DocumentGoneError);
  });

  it("read returns the bytes for the document's own address, through the owner's blob store", async () => {
    const seen: unknown[] = [];
    const asked: unknown[] = [];
    const source = new PgDocumentSource(f.app, (identity) => {
      seen.push(identity);
      return {
        get: async (r) => {
          asked.push(r);
          return Uint8Array.of(1, 2);
        },
      };
    });
    const ref = await f.doc("8".repeat(64));
    expect([...(await source.read(ref, addr("8")))]).toEqual([1, 2]);
    expect(seen).toEqual([{ tenantId: ref.tenantId, userId: ref.userId }]);
    expect(asked).toEqual([{ __loomContent: addr("8") }]);
  });

  it("read refuses an address that is not the document's, without touching the blob store", async () => {
    const ref = await f.doc("9".repeat(64));
    let touched = false;
    const source = new PgDocumentSource(f.app, () => {
      touched = true;
      return bytes();
    });
    await expect(source.read(ref, addr("a"))).rejects.toBeInstanceOf(DocumentGoneError);
    expect(touched).toBe(false);
  });

  it("read throws DocumentGoneError for another owner's, another tenant's and a missing document", async () => {
    const ref = await f.doc("b".repeat(64));
    let touched = false;
    const source = new PgDocumentSource(f.app, () => {
      touched = true;
      return bytes();
    });
    await expect(source.read({ ...ref, userId: U1B }, addr("b"))).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
    await expect(source.read({ ...ref, tenantId: T2 }, addr("b"))).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
    await expect(
      source.read({ ...ref, documentId: randomUUID() }, addr("b")),
    ).rejects.toBeInstanceOf(DocumentGoneError);
    expect(touched).toBe(false);
  });

  it("read treats a blob that is gone as DocumentGoneError", async () => {
    const ref = await f.doc("c".repeat(64));
    await expect(new PgDocumentSource(f.app, none).read(ref, addr("c"))).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
  });

  it.each([
    ["BlobCorruptError", () => new BlobCorruptError()],
    ["BlobKeyUnavailableError", () => new BlobKeyUnavailableError()],
  ])("read propagates %s from the blob store unchanged", async (_n, make) => {
    const c = _n === "BlobCorruptError" ? "d" : "e";
    const ref = await f.doc(c.repeat(64));
    const err = make();
    const source = new PgDocumentSource(f.app, () => ({
      get: async () => {
        throw err;
      },
    }));
    await expect(source.read(ref, addr(c))).rejects.toBe(err);
  });
});
