import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UploadDocumentResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
