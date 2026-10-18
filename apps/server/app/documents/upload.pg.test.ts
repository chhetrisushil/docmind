import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UploadDocumentResponse } from "@docmind/contracts";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FieldCrypto } from "../crypto/fields";
import { PG_URL } from "../db/testSupport";
import { type DocumentHarness, T1, TEXT, U1, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)("POST /api/documents (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("stores a document: 201, a decrypted DTO, an encrypted row and an encrypted blob", async () => {
    const bytes = TEXT("first");
    const res = await h.upload("alice", "Meeting notes.txt", bytes);
    expect(res.status).toBe(201);
    const body = (await res.json()) as UploadDocumentResponse;
    expect(body.duplicate).toBe(false);
    expect(body.document).toMatchObject({
      title: "Meeting notes",
      filename: "Meeting notes.txt",
      mime: "text/plain",
      sizeBytes: bytes.length,
      status: "uploaded",
      summary: null,
      stats: null,
    });

    const fp = await h.fingerprint("alice", bytes);
    const row = await h.owner.query(
      "SELECT title_enc::text AS t, filename_enc::text AS f, fingerprint, content_address, stats_enc FROM documents WHERE id = $1",
      [body.document.id],
    );
    expect(row.rows[0].t + row.rows[0].f).not.toContain("Meeting");
    expect(row.rows[0].fingerprint).toBe(fp);
    expect(row.rows[0].content_address).toBe(`hmac-sha256:${fp}`);
    expect(row.rows[0].stats_enc).toBeNull();

    const file = join(h.root, T1, U1, fp);
    expect(readFileSync(file).includes("plain text")).toBe(false);
    expect(readdirSync(join(h.root, T1, U1))).toEqual([fp]); // no temp file left
  });

  it("answers 401 without a session and stores nothing", async () => {
    const form = new FormData();
    form.append("file", new Blob([TEXT("anon")]), "a.txt");
    const res = await fetch(`${h.base}/api/documents`, { method: "POST", body: form });
    expect(res.status).toBe(401);
    const rows = await h.owner.query(
      "SELECT count(*)::int AS n FROM documents WHERE size_bytes = $1",
      [TEXT("anon").length],
    );
    expect(rows.rows[0].n).toBe(0);
  });
});

describe.skipIf(!PG_URL)("POST /api/documents failure paths (needs DOCMIND_TEST_PG_URL)", () => {
  // Each test sets the one failure it injects; afterEach clears it.
  const inject: {
    blobs?: boolean;
    stage?: boolean;
    seal?: boolean;
    open?: boolean;
    commit?: boolean;
  } = {};
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer({
      deps: (d) => ({
        ...d,
        blobs: (id) => {
          if (inject.blobs) throw new Error("blob store unavailable");
          const store = d.blobs(id);
          if (inject.stage) store.stage = async () => Promise.reject(new Error("stage failed"));
          return store;
        },
        fields: {
          forUser: (u: string) => {
            const real = d.fields.forUser(u);
            return {
              ...real,
              seal: (b: string, v: unknown) =>
                inject.seal ? Promise.reject(new Error("seal failed")) : real.seal(b, v),
              openText: (b: string, v: unknown) =>
                inject.open ? Promise.reject(new Error("open failed")) : real.openText(b, v),
            };
          },
        } as unknown as FieldCrypto,
        pool: new Proxy(d.pool, {
          get(target, prop) {
            if (prop !== "connect")
              return Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop);
            return async () => {
              const client = await target.connect();
              return new Proxy(client, {
                get(c, p) {
                  if (p === "query") {
                    return (...args: unknown[]) =>
                      inject.commit && args[0] === "COMMIT"
                        ? Promise.reject(new Error("commit failed"))
                        : (c.query as (...a: unknown[]) => unknown)(...args);
                  }
                  const v = Reflect.get(c, p);
                  return typeof v === "function" ? v.bind(c) : v;
                },
              }) as PoolClient;
            };
          },
        }),
      }),
    });
  });
  afterEach(() => {
    for (const k of Object.keys(inject)) inject[k as keyof typeof inject] = false;
  });
  afterAll(async () => {
    await h?.close();
  });

  const userDir = () => join(h.root, T1, U1);
  const files = () => (existsSync(userDir()) ? readdirSync(userDir()) : []);
  const rows = async (bytes: Buffer) =>
    (
      await h.owner.query("SELECT count(*)::int AS n FROM documents WHERE size_bytes = $1", [
        bytes.length,
      ])
    ).rows[0].n as number;

  it("answers 500 promptly when the blob store cannot be built, with a body that is never read", async () => {
    inject.blobs = true;
    const res = await h.upload("alice", "big.txt", Buffer.alloc(4 * 1024 * 1024, 97));
    expect(res.status).toBe(500);
    expect(res.headers.get("connection")).toBe("close");
  });

  it("answers 500 when staging fails before reading the body", async () => {
    inject.stage = true;
    const res = await h.upload("alice", "big.txt", Buffer.alloc(4 * 1024 * 1024, 98));
    expect(res.status).toBe(500);
    expect(res.headers.get("connection")).toBe("close");
  });

  it("leaves no temp file when sealing fails", async () => {
    inject.seal = true;
    const bytes = TEXT("seal-fails");
    expect((await h.upload("alice", "a.txt", bytes)).status).toBe(500);
    expect(files().filter((f) => f.startsWith(".tmp-"))).toEqual([]);
    expect(await rows(bytes)).toBe(0);
  });

  it("removes the blob and the row when a failure follows the blob commit inside the transaction", async () => {
    inject.open = true;
    const bytes = TEXT("after-commit");
    expect((await h.upload("alice", "a.txt", bytes)).status).toBe(500);
    expect(files()).not.toContain(await h.fingerprint("alice", bytes));
    expect(files().filter((f) => f.startsWith(".tmp-"))).toEqual([]);
    expect(await rows(bytes)).toBe(0);
  });

  it("keeps the blob when COMMIT itself fails (no row, an unreferenced blob is harmless)", async () => {
    inject.commit = true;
    const bytes = TEXT("commit-fails");
    expect((await h.upload("alice", "a.txt", bytes)).status).toBe(500);
    expect(files()).toContain(await h.fingerprint("alice", bytes));
    expect(await rows(bytes)).toBe(0);
    // A retry stores the document and re-links the blob.
    inject.commit = false;
    expect((await h.upload("alice", "a.txt", bytes)).status).toBe(201);
  });
});
