import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UploadDocumentResponse } from "@docmind/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import type { DocumentLimits } from "./limits";
import {
  type DocumentHarness,
  PDF,
  PNG,
  T1,
  TEXT,
  U1,
  U1B,
  startDocumentServer,
} from "./testHarness";

const filesOf = (h: DocumentHarness, tenant: string, user: string) => {
  const dir = join(h.root, tenant, user);
  return existsSync(dir) ? readdirSync(dir) : [];
};
const rowCount = async (h: DocumentHarness) =>
  (await h.owner.query("SELECT count(*)::int AS n FROM documents")).rows[0].n as number;
const code = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;

describe.skipIf(!PG_URL)("upload rejections and quotas (needs DOCMIND_TEST_PG_URL)", () => {
  const open: DocumentHarness[] = [];
  const harness = async (limits: Partial<DocumentLimits> = {}) => {
    const h = await startDocumentServer({ limits });
    open.push(h);
    return h;
  };
  afterAll(async () => {
    for (const h of open) await h.close();
  });

  it("refuses an unsupported type with 415 and leaves no row or file", async () => {
    const h = await harness();
    const res = await h.upload("alice", "tool.exe", Buffer.from("MZ\u0090\u0000\u0003"));
    expect(res.status).toBe(415);
    expect(await code(res)).toBe("unsupported_type");
    expect(await rowCount(h)).toBe(0);
    expect(filesOf(h, T1, U1)).toEqual([]);
  });

  it("answers a large unsupported file promptly with 415 and connection: close", async () => {
    const h = await harness();
    const big = Buffer.concat([
      Buffer.from("MZ\u0090\u0000\u0003"),
      Buffer.alloc(3 * 1024 * 1024, 7),
    ]);
    const res = await h.upload("alice", "tool.exe", big);
    expect(res.status).toBe(415);
    expect(res.headers.get("connection")).toBe("close");
    expect(await rowCount(h)).toBe(0);
    expect(filesOf(h, T1, U1)).toEqual([]);
  }, 10_000);

  it("refuses a request with no file, or not multipart, and a file over the limit", async () => {
    const h = await harness({ maxFileBytes: 64 });
    const none = await fetch(`${h.base}/api/documents`, {
      method: "POST",
      headers: { "x-test-user": "alice" },
      body: new FormData(),
    });
    expect(none.status).toBe(400);
    const json = await fetch(`${h.base}/api/documents`, {
      method: "POST",
      headers: { "x-test-user": "alice", "content-type": "application/json" },
      body: "{}",
    });
    expect(json.status).toBe(415);
    const big = await h.upload("alice", "big.txt", "x".repeat(65));
    expect(big.status).toBe(413);
    expect(await rowCount(h)).toBe(0);
    expect(filesOf(h, T1, U1)).toEqual([]);
  });

  it("stops at the tenant's document limit (403), counting every user of the tenant, but still answers duplicates", async () => {
    const h = await harness({ tenantMaxDocuments: 2 });
    expect((await h.upload("alice", "1.txt", TEXT("1"))).status).toBe(201);
    expect((await h.upload("alice2", "2.txt", TEXT("2"))).status).toBe(201); // same tenant, other user
    const third = await h.upload("alice", "3.txt", TEXT("3"));
    expect(third.status).toBe(403);
    expect(await code(third)).toBe("quota_exceeded");
    expect(await rowCount(h)).toBe(2);
    expect(filesOf(h, T1, U1)).toHaveLength(1); // the refused blob was not kept
    const dup = await h.upload("alice", "again.txt", TEXT("1"));
    expect(dup.status).toBe(200);
    expect(((await dup.json()) as UploadDocumentResponse).duplicate).toBe(true);
    expect((await h.upload("bob", "other-tenant.txt", TEXT("3"))).status).toBe(201); // other tenant unaffected
  });

  it("stops at the tenant's storage limit and starts no flow for the refused upload", async () => {
    const h = await harness({ tenantMaxBytes: 100 });
    expect((await h.upload("alice", "a.png", PNG("x".repeat(30)))).status).toBe(201); // 46 bytes
    expect((await h.upload("alice", "b.png", PNG("y".repeat(30)))).status).toBe(201); // 92 in total
    const calls = h.ingest.calls.length;
    const res = await h.upload("alice", "c.png", PNG("z".repeat(30)));
    expect(res.status).toBe(403);
    expect(await rowCount(h)).toBe(2);
    expect(filesOf(h, T1, U1)).toHaveLength(2);
    expect(h.ingest.calls).toHaveLength(calls);
  });

  it("admits exactly one of two concurrent uploads when only one fits", async () => {
    const h = await harness({ tenantMaxDocuments: 1 });
    const [a, b] = await Promise.all([
      h.upload("alice", "a.pdf", PDF("a")),
      h.upload("alice2", "b.pdf", PDF("b")),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 403]);
    expect(await rowCount(h)).toBe(1);
    expect(filesOf(h, T1, U1).length + filesOf(h, T1, U1B).length).toBe(1);
  });

  it("answers 429 with Retry-After when the user already has the maximum uploads in flight", async () => {
    const h = await harness({ maxConcurrentUploadsPerUser: 1 });
    const slot = h.inFlight.tryAcquire(U1, 1); // an upload that has not finished
    const refused = await h.upload("alice", "a.txt", TEXT("a"));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("5");
    expect((await h.upload("bob", "b.txt", TEXT("b"))).status).toBe(201); // another user is fine
    slot?.();
    expect((await h.upload("alice", "a.txt", TEXT("a"))).status).toBe(201);
    expect(await rowCount(h)).toBe(2);
  });
});
