import { randomUUID } from "node:crypto";
import type { ParsedDocument } from "@docmind/parsers";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../../crypto/fields";
import { PG_URL } from "../../db/testSupport";
import { U1B } from "../../documents/testHarness";
import { DocumentGoneError } from "./errors";
import { type PgFixture, startPgFixture } from "./pgFixture";
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

  it.each(["put", "take", "drop"] as const)(
    "%s throws DocumentGoneError for another owner's document and for a deleted one",
    async (op) => {
      const ref = await f.doc(randomUUID().replaceAll("-", "").repeat(2));
      const store = new PgParsedStore(f.app, f.fields);
      await store.put(ref, parsed);
      const before = await rawBody(ref.documentId);
      const call = (r: typeof ref) =>
        op === "put" ? store.put(r, parsed) : op === "take" ? store.take(r) : store.drop(r);
      await expect(call({ ...ref, userId: U1B })).rejects.toBeInstanceOf(DocumentGoneError);
      // The refused call changed nothing: the owner's row is intact.
      expect(await rawBody(ref.documentId)).toEqual(before);
      await f.db.owner.query("DELETE FROM documents WHERE id = $1", [ref.documentId]);
      await expect(call(ref)).rejects.toBeInstanceOf(DocumentGoneError);
    },
  );
});
