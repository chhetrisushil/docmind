import { randomUUID } from "node:crypto";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../../crypto/fields";
import { migrate, setAppRolePassword } from "../../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../../db/testSupport";
import { ALICE, BOB, U1, seedDoc, seedUsers } from "../../documents/testHarness";
import { DocumentGoneError } from "../ingest-document/errors";
import { PgVisualizeGuard } from "./pgGuard";

describe.skipIf(!PG_URL)("PgVisualizeGuard (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let guard: PgVisualizeGuard;
  let fields: FieldCrypto;
  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await seedUsers(db.owner);
    app = new Pool({ connectionString: db.appUrl });
    guard = new PgVisualizeGuard(app);
    fields = new FieldCrypto(new InMemoryKeyStore());
  });
  afterAll(async () => {
    await app.end();
    await db.drop();
  });
  const ref = (who: { tenantId: string; userId: string }, documentId: string) => ({
    ...who,
    documentId,
  });

  it("passes a live document on its generation; a missing one, another owner's and a superseded generation are gone", async () => {
    const doc = await seedDoc(db.owner, app, fields, ALICE, "f".repeat(64), 10);
    const gen = Number(
      (await db.owner.query("SELECT ingest_generation FROM documents WHERE id=$1", [doc])).rows[0]
        .ingest_generation,
    );
    await expect(guard.begin(ref(ALICE, doc), "visualize-load", gen)).resolves.toBeUndefined();
    await expect(guard.begin(ref(ALICE, doc), "visualize-load")).resolves.toBeUndefined();
    await expect(guard.begin(ref(ALICE, doc), "visualize-load", gen - 1)).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
    await expect(guard.begin(ref(ALICE, randomUUID()), "visualize-load")).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
    await expect(guard.begin(ref(BOB, doc), "visualize-load")).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
  });

  it("refuses a user whose erasure has begun (last: erasing_at is final)", async () => {
    const doc = await seedDoc(db.owner, app, fields, ALICE, "e".repeat(64), 10);
    await expect(guard.begin(ref(ALICE, doc), "visualize-extract")).resolves.toBeUndefined();
    await db.owner.query("UPDATE users SET erasing_at = now() WHERE id = $1", [U1]);
    await expect(guard.begin(ref(ALICE, doc), "visualize-extract")).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
  });
});
