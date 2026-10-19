import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { migrate, setAppRolePassword } from "../db/migrate";
import { withTenant } from "../db/tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { UPLOADED } from "../status/model";
import {
  DOCUMENT_COLUMNS,
  type DocumentRow,
  findByFingerprint,
  insertDocument,
  statsBind,
  titleBind,
  toDto,
} from "./repo";
import { T1, T2, U1, U1B, U2, newDocument, seedUsers } from "./testHarness";

const FP = (c: string) => c.repeat(64);

describe.skipIf(!PG_URL)("documents repository (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  const fields = new FieldCrypto(new InMemoryKeyStore());

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await seedUsers(db.owner);
    app = new Pool({ connectionString: db.appUrl });
  });
  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  const newDoc = (tenant: string, owner: string, fingerprint: string, sizeBytes = 10) =>
    newDocument(fields, tenant, owner, fingerprint, { sizeBytes });

  it("inserts a row and maps it to a DTO with decrypted title and filename", async () => {
    const doc = await newDoc(T1, U1, FP("1"), 1234);
    const dto = await withTenant(app, T1, async (tx) =>
      toDto(await insertDocument(tx, doc), fields.forUser(U1), UPLOADED),
    );
    expect(dto).toMatchObject({
      id: doc.id,
      title: "Quarterly report",
      filename: "Quarterly report.pdf",
      mime: "application/pdf",
      sizeBytes: 1234,
      status: "uploaded",
      error: null,
      stats: null,
      summary: null,
    });
    expect(new Date(dto.createdAt).toISOString()).toBe(dto.createdAt);
    const raw = await db.owner.query(
      "SELECT title_enc::text AS t, filename_enc::text AS f FROM documents WHERE id = $1",
      [doc.id],
    );
    expect(raw.rows[0].t + raw.rows[0].f).not.toContain("Quarterly");
  });

  it("finds a duplicate by owner and fingerprint only", async () => {
    await withTenant(app, T1, async (tx) => insertDocument(tx, await newDoc(T1, U1, FP("2"))));
    await withTenant(app, T1, async (tx) => {
      expect(await findByFingerprint(tx, U1, FP("2"))).toBeDefined();
      expect(await findByFingerprint(tx, U1B, FP("2"))).toBeUndefined(); // another user, same tenant
      expect(await findByFingerprint(tx, U1, FP("9"))).toBeUndefined();
    });
    await withTenant(app, T2, async (tx) => {
      expect(await findByFingerprint(tx, U2, FP("2"))).toBeUndefined(); // another tenant
    });
  });

  it("refuses to open a DTO whose envelope was moved to another document", async () => {
    const a = await newDoc(T1, U1, FP("5"));
    const b = await newDoc(T1, U1, FP("6"));
    const swapped = { ...a, titleEnc: b.titleEnc };
    await expect(
      withTenant(app, T1, async (tx) =>
        toDto(await insertDocument(tx, swapped), fields.forUser(U1), UPLOADED),
      ),
    ).rejects.toThrow();
  });

  it("opens stats_enc into the DTO's stats and never stores it in the clear", async () => {
    const doc = await newDoc(T1, U1, FP("7"));
    const cipher = fields.forUser(U1);
    const stats = {
      wordCount: 3,
      pageCount: null,
      readingTimeMinutes: 0.1,
      language: "en",
      outline: ["Secret heading"],
      dates: [],
      numbers: [],
    };
    const dto = await withTenant(app, T1, async (tx) => {
      await insertDocument(tx, doc);
      await tx.query("UPDATE documents SET stats_enc = $2::jsonb WHERE id = $1", [
        doc.id,
        JSON.stringify(await cipher.seal(statsBind(doc.id), stats)),
      ]);
      const { rows } = await tx.query<DocumentRow>(
        `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1`,
        [doc.id],
      );
      return toDto(rows[0] as DocumentRow, cipher, UPLOADED);
    });
    expect(dto.stats).toEqual(stats);
    const raw = await db.owner.query("SELECT stats_enc::text AS s FROM documents WHERE id = $1", [
      doc.id,
    ]);
    expect(raw.rows[0].s).not.toContain("Secret heading");
  });
});
