import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { insertDocument } from "../documents/repo";
import { T1, T2, U1, U1B, U2, newDocument } from "../documents/testHarness";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { documentTitles } from "./citations";

const ALICE = { tenantId: T1, userId: U1 };

describe.skipIf(!PG_URL)("documentTitles (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => {
    await fx.close();
  });

  async function seed(tenant: string, user: string, fp: string): Promise<string> {
    const d = await newDocument(fx.fields, tenant, user, fp.repeat(64));
    await withTenant(fx.app, tenant, (tx) => insertDocument(tx, d));
    return d.id;
  }

  it("returns the owner's titles, and leaves out documents that are gone, foreign or in another tenant", async () => {
    const mine = await seed(T1, U1, "a");
    const sameTenant = await seed(T1, U1B, "b");
    const otherTenant = await seed(T2, U2, "c");
    const got = await documentTitles(fx.app, fx.fields, ALICE, [
      mine,
      sameTenant,
      otherTenant,
      randomUUID(),
    ]);
    expect([...got.keys()]).toEqual([mine]);
    expect(got.get(mine)).toBe("Quarterly report");
  });

  it("asks the database nothing for no ids", async () => {
    expect((await documentTitles(fx.app, fx.fields, ALICE, [])).size).toBe(0);
  });
});
