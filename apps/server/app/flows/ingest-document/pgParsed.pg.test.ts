import { randomUUID } from "node:crypto";
import { ParseAbortedError, type ParsedDocument } from "@docmind/parsers";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../../crypto/fields";
import { PG_URL } from "../../db/testSupport";
import { U1, U1B } from "../../documents/testHarness";
import { chunkDocument } from "./chunker";
import { DocumentGoneError } from "./errors";
import { PgChunkStore } from "./pgChunks";
import { type PgFixture, startPgFixture } from "./pgFixture";
import { parsedBind } from "./pgParsed";
import { PgParsedStore } from "./pgParsed";

const SENTENCE = "A distinctive sentence about quarterly revenue.";
const parsed: ParsedDocument = {
  text: SENTENCE,
  sections: [
    { headingPath: ["Intro"], text: SENTENCE, locator: { kind: "chars", start: 0, end: 46 } },
  ],
  media: [],
};

describe.skipIf(!PG_URL)("PgParsedStore (needs DOCMIND_TEST_PG_URL)", () => {
  let f: PgFixture;
  beforeAll(async () => {
    f = await startPgFixture();
  });
  afterAll(async () => {
    await f?.close();
  });

  const rawBody = async (documentId: string) =>
    (
      await f.db.owner.query("SELECT body_enc FROM parsed_documents WHERE document_id = $1", [
        documentId,
      ])
    ).rows[0]?.body_enc;

  it("stores the parsed document sealed: the owner reads it back, the row holds only an envelope", async () => {
    const ref = await f.doc("3".repeat(64));
    const store = new PgParsedStore(f.app, f.fields);
    await store.put(ref, parsed);
    expect(await store.take(ref)).toEqual(parsed);
    const raw = await rawBody(ref.documentId);
    expect(Object.keys(raw).sort()).toEqual(["__loomEnc", "aad", "data", "iv", "tag"]);
    expect(raw.__loomEnc).toBe("loom/aes-256-gcm");
    expect(JSON.stringify(raw)).not.toContain("quarterly revenue");
  });

  it("throws FieldKeyUnavailableError without the owner's data key (stepEffect maps it to document_gone)", async () => {
    const ref = await f.doc("4".repeat(64));
    await new PgParsedStore(f.app, f.fields).put(ref, parsed);
    const strangers = new FieldCrypto(new InMemoryKeyStore());
    await expect(new PgParsedStore(f.app, strangers).take(ref)).rejects.toMatchObject({
      name: "FieldKeyUnavailableError",
    });
  });

  it("replaces on a re-run, returns undefined once dropped, and drop is idempotent", async () => {
    const ref = await f.doc("5".repeat(64));
    const store = new PgParsedStore(f.app, f.fields);
    await store.put(ref, parsed);
    await store.put(ref, { ...parsed, text: "second" });
    expect((await store.take(ref))?.text).toBe("second");
    await store.drop(ref);
    await store.drop(ref);
    expect(await store.take(ref)).toBeUndefined();
  });

  it("put invalidates what derives from the old parse: chunks are deleted and the summary cleared", async () => {
    const ref = await f.doc("d4".repeat(32));
    const store = new PgParsedStore(f.app, f.fields);
    await store.put(ref, parsed);
    await new PgChunkStore(f.app, f.fields).replace(ref, chunkDocument(parsed));
    await f.db.owner.query("UPDATE documents SET summary_enc = '{\"x\":1}'::jsonb WHERE id = $1", [
      ref.documentId,
    ]);
    const count = () => new PgChunkStore(f.app, f.fields).count(ref);
    expect(await count()).toBe(1);
    await store.put(ref, { ...parsed, text: "second" });
    expect(await count()).toBe(0);
    const { rows } = await f.db.owner.query("SELECT summary_enc FROM documents WHERE id = $1", [
      ref.documentId,
    ]);
    expect(rows[0].summary_enc).toBeNull();
  });

  it("an aborted put leaves the previous parsed row and the existing chunks untouched", async () => {
    const ref = await f.doc("e5".repeat(32));
    const store = new PgParsedStore(f.app, f.fields);
    await store.put(ref, parsed);
    const chunks = new PgChunkStore(f.app, f.fields);
    await chunks.replace(ref, chunkDocument(parsed));
    const before = await rawBody(ref.documentId);
    const ac = new AbortController();
    ac.abort();
    await expect(store.put(ref, { ...parsed, text: "late" }, ac.signal)).rejects.toBeInstanceOf(
      ParseAbortedError,
    );
    expect(await rawBody(ref.documentId)).toEqual(before);
    expect((await store.take(ref))?.text).toBe(parsed.text);
    expect(await chunks.count(ref)).toBe(1);
  });

  it("has is false before put, true after, and false after drop", async () => {
    const ref = await f.doc("c3".repeat(32));
    const store = new PgParsedStore(f.app, f.fields);
    expect(await store.has(ref)).toBe(false);
    await store.put(ref, parsed);
    expect(await store.has(ref)).toBe(true);
    await store.take(ref); // take reads without deleting
    expect(await store.has(ref)).toBe(true);
    await store.drop(ref);
    expect(await store.has(ref)).toBe(false);
  });

  it.each(["put", "take", "has", "drop"] as const)(
    "%s throws DocumentGoneError for another owner's document and for a deleted one",
    async (op) => {
      const ref = await f.doc(randomUUID().replaceAll("-", "").repeat(2));
      const store = new PgParsedStore(f.app, f.fields);
      await store.put(ref, parsed);
      const before = await rawBody(ref.documentId);
      const call = (r: typeof ref) =>
        op === "put"
          ? store.put(r, parsed)
          : op === "take"
            ? store.take(r)
            : op === "has"
              ? store.has(r)
              : store.drop(r);
      await expect(call({ ...ref, userId: U1B })).rejects.toBeInstanceOf(DocumentGoneError);
      // The refused call changed nothing: the owner's row is intact.
      expect(await rawBody(ref.documentId)).toEqual(before);
      await f.db.owner.query("DELETE FROM documents WHERE id = $1", [ref.documentId]);
      await expect(call(ref)).rejects.toBeInstanceOf(DocumentGoneError);
    },
  );

  it("does not open an envelope copied into another document's row (bound to the document)", async () => {
    const a = await f.doc("6".repeat(64));
    const b = await f.doc("7".repeat(64));
    const store = new PgParsedStore(f.app, f.fields);
    await store.put(a, parsed);
    await store.put(b, parsed);
    await f.db.owner.query(
      "UPDATE parsed_documents SET body_enc = (SELECT body_enc FROM parsed_documents WHERE document_id = $1) WHERE document_id = $2",
      [a.documentId, b.documentId],
    );
    await expect(store.take(a)).resolves.toEqual(parsed);
    await expect(store.take(b)).rejects.toBeInstanceOf(Error);
    await expect(store.take(b)).rejects.not.toBeInstanceOf(DocumentGoneError);
  });

  it("rejects a sealed payload of the wrong shape with a fixed message that carries no content", async () => {
    const ref = await f.doc("8".repeat(64));
    const secret = "wrong-shape-secret-value";
    const sealed = await f.fields.forUser(U1).seal(parsedBind(ref.documentId), { text: 1, secret });
    await new PgParsedStore(f.app, f.fields).put(ref, parsed);
    await f.db.owner.query(
      "UPDATE parsed_documents SET body_enc = $2::jsonb WHERE document_id = $1",
      [ref.documentId, JSON.stringify(sealed)],
    );
    const err = await new PgParsedStore(f.app, f.fields).take(ref).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const e = err as Error;
    expect(e.message).toBe("the stored parsed document has an invalid shape");
    expect(e.cause).toBeUndefined();
    expect(JSON.stringify([e.message, e.cause])).not.toContain(secret);
  });

  it("a drop whose attempt was abandoned (aborted signal) rolls back and leaves the row", async () => {
    const ref = await f.doc("a1".repeat(32));
    const store = new PgParsedStore(f.app, f.fields);
    await store.put(ref, parsed);
    const abandoned = AbortSignal.abort();
    await expect(store.drop(ref, abandoned)).rejects.toBeInstanceOf(ParseAbortedError);
    expect(await rawBody(ref.documentId)).toBeDefined();
    await store.drop(ref);
    expect(await rawBody(ref.documentId)).toBeUndefined();
  });
});
