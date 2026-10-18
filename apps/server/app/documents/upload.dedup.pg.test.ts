import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UploadDocumentResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import {
  type DocumentHarness,
  PNG,
  T1,
  T2,
  TEXT,
  U1,
  U2,
  startDocumentServer,
} from "./testHarness";

describe.skipIf(!PG_URL)("upload dedup and keyed names (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("never stores or names anything by the plain sha256 of the bytes", async () => {
    const bytes = TEXT("keyed not plain");
    await h.upload("alice", "k.txt", bytes);
    const plain = createHash("sha256").update(bytes).digest("hex");
    expect(existsSync(join(h.root, T1, U1, plain))).toBe(false);
    const rows = await h.owner.query(
      "SELECT count(*)::int AS n FROM documents WHERE fingerprint = $1 OR content_address LIKE $2",
      [plain, `%${plain}`],
    );
    expect(rows.rows[0].n).toBe(0);
  });

  it("decides the type from the bytes, not the extension", async () => {
    const res = await h.upload("alice", "photo.txt", PNG("a"));
    expect(res.status).toBe(201);
    expect(((await res.json()) as UploadDocumentResponse).document.mime).toBe("image/png");
  });

  it("returns the existing document for identical bytes: 200, duplicate, one row, one file", async () => {
    const bytes = TEXT("dup");
    const first = (await (
      await h.upload("alice", "a.txt", bytes)
    ).json()) as UploadDocumentResponse;
    const again = await h.upload("alice", "renamed.txt", bytes);
    expect(again.status).toBe(200);
    const body = (await again.json()) as UploadDocumentResponse;
    expect(body.duplicate).toBe(true);
    expect(body.document.id).toBe(first.document.id);
    expect(body.document.filename).toBe("a.txt"); // the first upload's name is kept
    const fp = await h.fingerprint("alice", bytes);
    const rows = await h.owner.query(
      "SELECT count(*)::int AS n FROM documents WHERE fingerprint = $1",
      [fp],
    );
    expect(rows.rows[0].n).toBe(1);
    expect(readdirSync(join(h.root, T1, U1)).filter((f) => f === fp)).toHaveLength(1);
  });

  it("does not deduplicate across users: each keeps their own document, fingerprint and blob", async () => {
    const bytes = TEXT("shared bytes");
    const a = (await (await h.upload("alice", "x.txt", bytes)).json()) as UploadDocumentResponse;
    const b = await h.upload("bob", "x.txt", bytes);
    expect(b.status).toBe(201);
    const bodyB = (await b.json()) as UploadDocumentResponse;
    expect(bodyB.duplicate).toBe(false);
    expect(bodyB.document.id).not.toBe(a.document.id);
    const fpAlice = await h.fingerprint("alice", bytes);
    const fpBob = await h.fingerprint("bob", bytes);
    expect(fpAlice).not.toBe(fpBob); // the same file looks different under each user's key
    expect(existsSync(join(h.root, T1, U1, fpAlice))).toBe(true);
    expect(existsSync(join(h.root, T2, U2, fpBob))).toBe(true);
  });
});
