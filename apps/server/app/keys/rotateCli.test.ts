import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { type Kek, PostgresKeyStore } from "@docmind/keystore-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { runRotation } from "./rotateKek";

const oldKek: Kek = { id: "kek-1", key: createSecretKey(randomBytes(32)) };
const newKek: Kek = { id: "kek-2", key: createSecretKey(randomBytes(32)) };

describe.skipIf(!PG_URL)("the rotation command (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  const deks = new Map<string, Buffer>();

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
    const store = new PostgresKeyStore(app, [oldKek]);
    for (let i = 0; i < 3; i++) {
      const subject = randomUUID();
      deks.set(subject, await store.getOrCreate(subject));
    }
  });

  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  it("never prints a data key, and exits non-zero until everything is rotated", async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    expect(await runRotation(db.owner, [newKek, oldKek], {}, log)).toBe(0);
    expect(lines).toEqual([
      "rotated 3 key(s) to kek-2",
      "3 key(s) open with kek-2 alone; 0 on another KEK; 0 do not open",
    ]);
    const secrets = [...deks.values()].flatMap((d) => [d.toString("hex"), d.toString("base64")]);
    for (const secret of secrets) expect(lines.join("\n")).not.toContain(secret);

    const [first] = [...deks.keys()];
    await db.owner.query("UPDATE data_keys SET kek_id = 'kek-1' WHERE subject_id = $1", [first]);
    expect(await runRotation(db.owner, [newKek], { verifyOnly: true }, log)).toBe(1);
  });
});
