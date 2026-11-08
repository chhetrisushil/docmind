import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { deleteDocument, insertDocument } from "../documents/repo";
import { T1, U1, U1B, newDocument } from "../documents/testHarness";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { ownedDocumentIds } from "./routes";

const ALICE = { tenantId: T1, userId: U1 };

describe.skipIf(!PG_URL)(
  "ownedDocumentIds, the default of the turn view (needs DOCMIND_TEST_PG_URL)",
  () => {
    let fx: PgFixture;
    beforeAll(async () => {
      fx = await startPgFixture();
    });
    afterAll(async () => {
      await fx.close();
    });

    async function seed(user: string, fp: string): Promise<string> {
      const d = await newDocument(fx.fields, T1, user, fp.repeat(64));
      await withTenant(fx.app, T1, (tx) => insertDocument(tx, d));
      return d.id;
    }

    it("keeps the caller's document and leaves out a foreign one, a deleted one and an unknown id", async () => {
      const mine = await seed(U1, "d");
      const foreign = await seed(U1B, "e");
      const gone = await seed(U1, "f");
      await withTenant(fx.app, T1, (tx) => deleteDocument(tx, U1, gone));
      const owned = await ownedDocumentIds(fx.app, ALICE, [mine, foreign, gone, randomUUID()]);
      expect([...owned]).toEqual([mine]);
    });

    it("asks the database nothing for no ids", async () => {
      expect((await ownedDocumentIds(fx.app, ALICE, [])).size).toBe(0);
    });
  },
);
