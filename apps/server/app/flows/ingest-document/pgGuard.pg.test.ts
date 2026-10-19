import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../../db/testSupport";
import { T2, U1B } from "../../documents/testHarness";
import { DocumentGoneError } from "./errors";
import { type PgFixture, startPgFixture } from "./pgFixture";
import { PgStepGuard } from "./pgGuard";

describe.skipIf(!PG_URL)("PgStepGuard (needs DOCMIND_TEST_PG_URL)", () => {
  let f: PgFixture;
  beforeAll(async () => {
    f = await startPgFixture();
  });
  afterAll(async () => {
    await f?.close();
  });

  it("passes for a document's owner in its own tenant", async () => {
    const ref = await f.doc("e".repeat(64));
    await expect(new PgStepGuard(f.app).begin(ref, "parse")).resolves.toBeUndefined();
  });

  it("throws DocumentGoneError for another owner's, another tenant's, an unknown and a deleted document", async () => {
    const ref = await f.doc("d".repeat(64));
    const guard = new PgStepGuard(f.app);
    await expect(guard.begin({ ...ref, userId: U1B }, "parse")).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
    await expect(guard.begin({ ...ref, tenantId: T2 }, "parse")).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
    await expect(guard.begin({ ...ref, documentId: randomUUID() }, "parse")).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
    await f.db.owner.query("DELETE FROM documents WHERE id = $1", [ref.documentId]);
    await expect(guard.begin(ref, "parse")).rejects.toBeInstanceOf(DocumentGoneError);
  });

  it("fails with a fixed message that carries none of the ids", async () => {
    const ref = await f.doc("c".repeat(64));
    const bad = "not-a-uuid-marker";
    const err = await new PgStepGuard(f.app)
      .begin({ ...ref, documentId: bad }, "parse")
      .catch((e: unknown) => e);
    expect(err).toEqual(new Error("document existence check failed"));
    expect((err as Error).message).not.toContain(bad);
    expect((err as Error).cause).toBeUndefined();
  });

  it("refuses a generation other than the document's current one", async () => {
    const ref = await f.doc("b".repeat(64));
    const guard = new PgStepGuard(f.app);
    const current = (
      await f.db.owner.query<{ ingest_generation: number }>(
        "SELECT ingest_generation FROM documents WHERE id = $1",
        [ref.documentId],
      )
    ).rows[0]?.ingest_generation as number;
    await expect(guard.begin(ref, "parse", current)).resolves.toBeUndefined();
    await f.db.owner.query("UPDATE documents SET ingest_generation = $2 WHERE id = $1", [
      ref.documentId,
      current + 1,
    ]);
    await expect(guard.begin(ref, "parse", current)).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(guard.begin(ref, "parse", current + 1)).resolves.toBeUndefined();
    await expect(guard.begin(ref, "parse")).resolves.toBeUndefined();
  });
});
