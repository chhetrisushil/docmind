import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../../crypto/fields";
import { migrate, setAppRolePassword } from "../../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../../db/testSupport";
import {
  ALICE,
  BOB,
  U1,
  U2,
  backfillExecutionIds,
  seedDoc,
  seedRow,
  seedUsers,
} from "../../documents/testHarness";
import { legacyIngestId, legacyVisualizeId } from "../../opaqueIds/testing";
import { pgReadyDocuments } from "./start";

const NIL = "00000000-0000-0000-0000-000000000000";

describe.skipIf(!PG_URL)("docmind_ready_documents (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let owner: Pool;
  let app: Pool;
  let fields: FieldCrypto;
  let n = 0;
  const fp = () => (n++).toString(16).padStart(64, "0");
  const ready = '{"status":"ready","step":"finalize","code":null}';

  beforeAll(async () => {
    db = await createTestDb();
    owner = db.owner;
    await migrate(owner);
    await setAppRolePassword(owner, APP_PASSWORD);
    await seedUsers(owner);
    app = new Pool({ connectionString: db.appUrl });
    fields = new FieldCrypto(new InMemoryKeyStore());
  });
  afterAll(async () => {
    await app.end();
    await db.drop();
  });

  const generationOf = async (id: string) =>
    Number(
      (await owner.query("SELECT ingest_generation FROM documents WHERE id = $1", [id])).rows[0]
        .ingest_generation,
    );

  it("lists ready documents of the current generation with no visualize row, across tenants, paged by id", async () => {
    await owner.query("DELETE FROM documents");
    const mine = await seedDoc(owner, app, fields, ALICE, fp(), 600); // ready, never visualized
    const theirs = await seedDoc(owner, app, fields, BOB, fp(), 600); // ready, another tenant
    const done = await seedDoc(owner, app, fields, ALICE, fp(), 600); // ready, visualize execution exists
    const running = await seedDoc(owner, app, fields, ALICE, fp(), 600); // not ready
    const failed = await seedDoc(owner, app, fields, ALICE, fp(), 600); // failed ingest
    const old = await seedDoc(owner, app, fields, ALICE, fp(), 600); // ready at an older generation only
    const g = async (id: string) => generationOf(id);
    await seedRow(owner, legacyIngestId(U1, mine, await g(mine)), mine, U1, ready);
    await seedRow(owner, legacyIngestId(U2, theirs, await g(theirs)), theirs, U2, ready);
    await seedRow(owner, legacyIngestId(U1, done, await g(done)), done, U1, ready);
    // Loom writes a (neutral, key-less) row for the visualize execution itself.
    await owner.query(
      "INSERT INTO read_model_state (model_id, execution_id, app_key, scope, sequence, state) VALUES ('ingest-status', $1, NULL, NULL, 0, '{}')",
      [legacyVisualizeId(U1, done, await g(done))],
    );
    await backfillExecutionIds(owner);
    await seedRow(
      owner,
      legacyIngestId(U1, running, await g(running)),
      running,
      U1,
      '{"status":"embedding","step":"embed","code":null}',
    );
    await seedRow(
      owner,
      legacyIngestId(U1, failed, await g(failed)),
      failed,
      U1,
      '{"status":"failed","step":"parse","code":"internal"}',
    );
    await seedRow(owner, legacyIngestId(U1, old, (await g(old)) - 1), old, U1, ready);
    const list = pgReadyDocuments(app);
    const all = await list(NIL, 100);
    expect(all.map((d) => d.documentId)).toEqual([mine, theirs].sort());
    const aMine = all.find((d) => d.documentId === mine);
    expect(aMine).toEqual({
      tenantId: ALICE.tenantId,
      userId: U1,
      documentId: mine,
      generation: await g(mine),
    });
    // Keyset paging: one at a time, by the last id.
    const first = await list(NIL, 1);
    const second = await list(first[0]?.documentId as string, 1);
    expect([first[0]?.documentId, second[0]?.documentId]).toEqual([mine, theirs].sort());
    expect(await list(second[0]?.documentId as string, 1)).toEqual([]);
  });

  it("skips a user being erased and answers nothing to a null argument (STRICT)", async () => {
    await owner.query("DELETE FROM documents");
    const doc = await seedDoc(owner, app, fields, ALICE, fp(), 600);
    await seedRow(owner, legacyIngestId(U1, doc, await generationOf(doc)), doc, U1, ready);
    expect(await pgReadyDocuments(app)(NIL, 10)).toHaveLength(1);
    expect((await app.query("SELECT * FROM docmind_ready_documents(NULL, 10)")).rows).toEqual([]);
    expect(
      (await app.query("SELECT * FROM docmind_ready_documents($1, NULL)", [NIL])).rows,
    ).toEqual([]);
    await owner.query("UPDATE users SET erasing_at = now() WHERE id = $1", [U1]); // final: last in this file
    expect(await pgReadyDocuments(app)(NIL, 10)).toEqual([]);
  });
});
