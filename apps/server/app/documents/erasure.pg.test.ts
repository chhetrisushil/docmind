import { existsSync } from "node:fs";
import { join } from "node:path";
import { eraseUserBlobs } from "@docmind/blob-store";
import type { DocumentDto } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import {
  type DocumentHarness,
  T1,
  T2,
  TEXT,
  U1,
  U1B,
  U2,
  startDocumentServer,
} from "./testHarness";

describe.skipIf(!PG_URL)("the erasure shape (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => {
    await h?.close();
  });

  const create = async (name: string, bytes: Buffer, user: string) =>
    ((await (await h.upload(user, name, bytes)).json()) as { document: DocumentDto }).document;
  const count = async (sql: string, args: unknown[]) =>
    (await h.owner.query(sql, args)).rows[0].n as number;
  const blob = (tenant: string, user: string, fp: string) => join(h.root, tenant, user, fp);

  it("is the shape erasure needs: deleting the user removes their rows, then their blobs go, then the key", async () => {
    const bytes = TEXT("erase everything");
    const doc = await create("e.txt", bytes, "alice2");
    const fp = await h.fingerprint("alice2", bytes);
    const others = [
      { user: "alice", tenant: T1, uid: U1, bytes: TEXT("colleague stays") },
      { user: "bob", tenant: T2, uid: U2, bytes: TEXT("other tenant stays") },
    ];
    const kept = [];
    for (const o of others) {
      const d = await create("k.txt", o.bytes, o.user);
      kept.push({ ...o, id: d.id, fp: await h.fingerprint(o.user, o.bytes) });
    }
    const mine = blob(T1, U1B, fp);
    expect(existsSync(mine)).toBe(true);

    await h.owner.query("DELETE FROM users WHERE id = $1", [U1B]); // cascades
    expect(await count("SELECT count(*)::int AS n FROM documents WHERE id = $1", [doc.id])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM documents WHERE owner_id = $1", [U1B])).toBe(
      0,
    );
    await eraseUserBlobs(h.root, T1, U1B);
    await eraseUserBlobs(h.root, T1, U1B); // idempotent
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(join(h.root, T1, U1B))).toBe(false);

    for (const k of kept) {
      expect(await count("SELECT count(*)::int AS n FROM documents WHERE id = $1", [k.id])).toBe(1);
      expect(existsSync(blob(k.tenant, k.uid, k.fp))).toBe(true);
    }

    await h.keys.destroy(U1B); // and then the key
    expect(await h.keys.wasDestroyed(U1B)).toBe(true);
    // With the key gone the fingerprint of a known file can no longer be computed.
    await expect(h.fingerprint("alice2", bytes)).rejects.toThrow(/^key for subject ".*"/);
  });
});
