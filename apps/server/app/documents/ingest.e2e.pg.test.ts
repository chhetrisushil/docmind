import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EncryptedFsContentStore } from "@docmind/blob-store";
import type {
  DocumentDto,
  ListDocumentsResponse,
  UploadDocumentResponse,
} from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { chunkBind } from "../flows/ingest-document/pgChunks";
import { assertEventsAreContentFree } from "../flows/ingest-document/testing";
import { STATUS_MESSAGES } from "../status/model";
import { FLOW_MISMATCH_REASON } from "../status/model";
import { ingestExecutionId } from "./ingest";
import { type IngestStack, startIngestStack } from "./ingestStack";
import { insertDocument } from "./repo";
import { sweepStaleUploads } from "./sweep";
import { makePdf, newDocument } from "./testHarness";

const SENTENCE = "Nocturne quarterly revenue forecast: seventeen thousand dollars.";
const LONG_TEXT = Array.from(
  { length: 12 },
  (_, i) => `Paragraph ${i}. ${SENTENCE} ${"lorem ipsum dolor sit amet ".repeat(14)}`,
).join("\n\n");
const WAIT = 30_000;

describe.skipIf(!PG_URL)(
  "M3 part 1 acceptance: a txt upload reaches ready (needs DOCMIND_TEST_PG_URL)",
  () => {
    let st: IngestStack;
    beforeAll(async () => {
      st = await startIngestStack();
    });
    afterAll(async () => {
      await st?.close();
    });

    it(
      "signs up, uploads a txt, sees progress over SSE until ready, and ends with sealed chunks and vectors",
      async () => {
        const MODEL = st.composed.ingestWiring.embedder.modelId; // ollama/fake-embed
        const ada = await st.signUpAndLogIn("ada@example.com");
        const stream = await st.events(ada.cookie);
        const res = await st.upload(ada.cookie, "notes.txt", Buffer.from(LONG_TEXT));
        expect(res.status).toBe(201);
        const id = ((await res.json()) as UploadDocumentResponse).document.id;

        const seen = await st.until(stream, id, (s) => s === "ready" || s === "failed");
        stream.close();
        // one event per step start, and `ready` when finalize's completion is folded (finalize appears twice)
        expect(seen.map((e) => e.step)).toEqual([
          "parse",
          "chunk",
          "embed",
          "analyze",
          "summarize",
          "link",
          "finalize",
          "finalize",
        ]);
        expect(seen.map((e) => e.status)).toEqual([
          "parsing",
          "parsing",
          "embedding",
          "embedding",
          "embedding",
          "embedding",
          "embedding",
          "ready",
        ]);
        // the SSE events carry ids, steps, statuses and fixed codes only
        for (const e of seen) {
          expect(
            Object.keys(e).every((k) => ["documentId", "step", "status", "detail"].includes(k)),
          ).toBe(true);
          expect(JSON.stringify(e)).not.toContain("Nocturne");
        }

        const doc = (await (
          await fetch(`${st.base}/api/documents/${id}`, { headers: { cookie: ada.cookie } })
        ).json()) as DocumentDto;
        expect([doc.status, doc.error]).toEqual(["ready", null]);
        const list = (await (
          await fetch(`${st.base}/api/documents`, { headers: { cookie: ada.cookie } })
        ).json()) as ListDocumentsResponse;
        expect(list.items.find((d) => d.id === id)?.status).toBe("ready");
        expect(
          (
            await st.db.owner.query(
              "SELECT app_key, scope, state FROM read_model_state WHERE app_key = $1",
              [id],
            )
          ).rows,
        ).toEqual([
          {
            app_key: id,
            scope: ada.userId,
            state: { status: "ready", step: "finalize", code: null },
          },
        ]);

        const chunks = (
          await st.db.owner.query(
            "SELECT id, text_enc, locator, embedding IS NOT NULL AS has_vec, embedding_model FROM chunks WHERE document_id = $1 ORDER BY ordinal",
            [id],
          )
        ).rows;
        expect(chunks.length).toBeGreaterThan(1);
        // sealed: an envelope, never the text, and it opens for the owner
        expect(chunks.every((c) => c.text_enc.__loomEnc === "loom/aes-256-gcm")).toBe(true);
        expect(JSON.stringify(chunks.map((c) => c.text_enc))).not.toContain("Nocturne");
        expect(chunks.every((c) => c.locator.kind === "chars")).toBe(true);
        const first = (await st.fields
          .forUser(ada.userId)
          .open(chunkBind(chunks[0].id), chunks[0].text_enc)) as { text: string };
        expect(first.text).toContain(SENTENCE);
        // every chunk has its embedding and the model that made it
        expect(chunks.every((c) => c.has_vec === true && c.embedding_model === MODEL)).toBe(true);
        expect(
          await st.composed.vectors.missing(
            { tenantId: ada.tenantId, ownerId: ada.userId },
            id,
            1000,
          ),
        ).toEqual([]);
        expect(
          (await st.db.owner.query("SELECT 1 FROM parsed_documents WHERE document_id = $1", [id]))
            .rowCount,
        ).toBe(0);

        // the raw event log of that ingest holds ids, outcomes, counts and the model id only
        assertEventsAreContentFree(
          await st.durable.raw.eventStore.read(ingestExecutionId(ada.userId, id)),
          { tenantId: ada.tenantId, userId: ada.userId, documentId: id },
          MODEL,
        );
      },
      WAIT,
    );

    it(
      "shows another user nothing: not the document, its events, its list entry, its delete, its dedup or its rows",
      async () => {
        const ada = await st.signUpAndLogIn("ada-iso@example.com");
        const grace = await st.signUpAndLogIn("grace@example.com");
        expect(grace.tenantId).not.toBe(ada.tenantId); // sign-up gives each user a tenant: cross-tenant too
        const adaStream = await st.events(ada.cookie);
        const graceStream = await st.events(grace.cookie);
        const adaBytes = Buffer.from(LONG_TEXT);
        const adaId = (
          (await (
            await st.upload(ada.cookie, "ada.txt", adaBytes)
          ).json()) as UploadDocumentResponse
        ).document.id;
        await st.until(adaStream, adaId, (s) => s === "ready"); // ada's document is done first
        adaStream.close();

        // Grace uploads the very same bytes: she gets her own document, never ada's.
        const dup = await st.upload(grace.cookie, "grace.txt", adaBytes);
        expect(dup.status).toBe(201);
        const graceId = ((await dup.json()) as UploadDocumentResponse).document.id;
        expect(graceId).not.toBe(adaId);
        // Every raw frame on grace's stream, until her own document is ready: none names ada's document.
        const raw: string[] = [];
        for (;;) {
          const frame = await graceStream.next();
          raw.push(frame);
          if (frame.includes(graceId) && frame.includes('"status":"ready"')) break;
        }
        graceStream.close();
        expect(raw.some((f) => f.includes(adaId))).toBe(false);

        const as = (cookie: string, path: string, method = "GET") =>
          fetch(`${st.base}${path}`, { method, headers: { cookie } });
        const missing = await as(
          grace.cookie,
          "/api/documents/00000000-0000-4000-8000-000000000000",
        );
        const foreign = await as(grace.cookie, `/api/documents/${adaId}`);
        expect([foreign.status, await foreign.text()]).toEqual([
          missing.status,
          await missing.text(),
        ]);
        expect(foreign.status).toBe(404);
        const list = (await (
          await as(grace.cookie, "/api/documents")
        ).json()) as ListDocumentsResponse;
        expect(list.items.map((d) => d.id)).toEqual([graceId]);
        expect((await as(grace.cookie, `/api/documents/${adaId}`, "DELETE")).status).toBe(404);
        const still = await as(ada.cookie, `/api/documents/${adaId}`);
        expect(((await still.json()) as DocumentDto).status).toBe("ready"); // the foreign delete changed nothing

        // Same tenant, different owner: row-level security does not separate them, the owner filter does.
        const heidi = await st.signUpAndLogIn("heidi@example.com");
        await st.db.owner.query("DELETE FROM auth_sessions WHERE user_id = $1", [heidi.userId]);
        await st.db.owner.query("UPDATE users SET tenant_id = $1 WHERE id = $2", [
          ada.tenantId,
          heidi.userId,
        ]);
        const relogin = await fetch(`${st.base}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "heidi@example.com", password: "correct horse battery" }),
        });
        heidi.cookie = (relogin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
        expect(
          ((await (await as(heidi.cookie, "/api/documents")).json()) as ListDocumentsResponse)
            .items,
        ).toEqual([]);
        expect((await as(heidi.cookie, `/api/documents/${adaId}`)).status).toBe(404);
        expect((await as(heidi.cookie, `/api/documents/${adaId}`, "DELETE")).status).toBe(404);
        expect(
          ((await (await as(ada.cookie, `/api/documents/${adaId}`)).json()) as DocumentDto).status,
        ).toBe("ready");

        // The database: grace's tenant sees no row of ada's, through the app role under row-level security.
        const rows = await withTenant(st.app, grace.tenantId, async (tx) => ({
          chunks: (await tx.query("SELECT 1 FROM chunks WHERE document_id = $1", [adaId])).rowCount,
          vectors: (
            await tx.query(
              "SELECT 1 FROM chunks WHERE document_id = $1 AND embedding IS NOT NULL",
              [adaId],
            )
          ).rowCount,
          documents: (await tx.query("SELECT 1 FROM documents WHERE id = $1", [adaId])).rowCount,
        }));
        expect(rows).toEqual({ chunks: 0, vectors: 0, documents: 0 });
        expect(
          (await st.db.owner.query("SELECT 1 FROM chunks WHERE document_id = $1", [adaId]))
            .rowCount,
        ).toBeGreaterThan(1); // ada's rows exist, so the zeros above are isolation
      },
      WAIT,
    );

    // The raw event log of one run holds ids, outcomes, counts, fixed codes and the model id only.
    const assertLogContentFree = async (user: { userId: string; tenantId: string }, id: string) =>
      assertEventsAreContentFree(
        await st.durable.raw.eventStore.read(ingestExecutionId(user.userId, id)),
        { tenantId: user.tenantId, userId: user.userId, documentId: id },
        st.composed.ingestWiring.embedder.modelId,
      );

    const filesOf = (userId: string) =>
      readdirSync(st.root, { recursive: true, withFileTypes: true }).filter(
        (e) => e.isFile() && (e.parentPath ?? "").includes(userId),
      );
    const del = (cookie: string, id: string) =>
      fetch(`${st.base}/api/documents/${id}`, { method: "DELETE", headers: { cookie } });
    // The status rows of a deleted document are tombstoned: erased, state gone, ids kept.
    const expectTombstoned = async (id: string) => {
      const rows = (
        await st.db.owner.query("SELECT erased, state FROM read_model_state WHERE app_key = $1", [
          id,
        ])
      ).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.erased === true && r.state === null)).toBe(true);
    };
    const countOf = async (table: string, id: string) =>
      (
        await st.db.owner.query(
          `SELECT 1 FROM ${table} WHERE ${table === "documents" ? "id" : "document_id"} = $1`,
          [id],
        )
      ).rowCount;
    const idOf = async (res: Response) =>
      ((await res.json()) as UploadDocumentResponse).document.id;
    const getDoc = async (cookie: string, id: string) =>
      (await (
        await fetch(`${st.base}/api/documents/${id}`, { headers: { cookie } })
      ).json()) as DocumentDto;
    const textOf = (word: string) => Buffer.from(LONG_TEXT.replace("Nocturne", word));

    it(
      "ends a binary file named .txt as failed with the parser's fixed message and stores no chunks",
      async () => {
        const user = await st.signUpAndLogIn("binary@example.com");
        const stream = await st.events(user.cookie);
        const bytes = Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0xff, 0xff, 0x00, 0xd8]); // UTF-16 BOM, then a noncharacter and a lone surrogate
        const id = await idOf(await st.upload(user.cookie, "data.txt", bytes));
        const seen = await st.until(stream, id, (s) => s === "failed");
        stream.close();
        expect(seen.at(-1)).toEqual({
          documentId: id,
          step: "parse",
          status: "failed",
          detail: "corrupt_content",
        });
        const doc = await getDoc(user.cookie, id);
        expect([doc.status, doc.error]).toEqual(["failed", STATUS_MESSAGES.corrupt_content]);
        expect(
          (await st.db.owner.query("SELECT 1 FROM chunks WHERE document_id = $1", [id])).rowCount,
        ).toBe(0);
        await assertLogContentFree(user, id);
      },
      WAIT,
    );

    it(
      "ingests a text pdf through the pdf parser to ready",
      async () => {
        const user = await st.signUpAndLogIn("pdf@example.com");
        const stream = await st.events(user.cookie);
        const id = await idOf(
          await st.upload(user.cookie, "report.pdf", makePdf("Acceptance pdf text")),
        );
        const seen = await st.until(stream, id, (s) => s === "ready" || s === "failed");
        stream.close();
        expect(seen.at(-1)?.status).toBe("ready");
        expect((await getDoc(user.cookie, id)).status).toBe("ready");
        await assertLogContentFree(user, id);
      },
      WAIT,
    );

    it(
      "retries a transient embedder failure (503) and still reaches ready",
      async () => {
        const user = await st.signUpAndLogIn("transient@example.com");
        const stream = await st.events(user.cookie);
        st.fake.failNext(503); // the first embed request; the retry succeeds
        const id = await idOf(await st.upload(user.cookie, "transient.txt", textOf("Transient")));
        const seen = await st.until(stream, id, (s) => s === "ready" || s === "failed");
        stream.close();
        expect(seen.at(-1)?.status).toBe("ready");
        expect((await getDoc(user.cookie, id)).error).toBeNull();
        await assertLogContentFree(user, id);
      },
      WAIT,
    );

    it(
      "a permanent embedder failure ends failed/internal with a terminal event without a step, and no retry",
      async () => {
        const user = await st.signUpAndLogIn("outage@example.com");
        const stream = await st.events(user.cookie);
        const spy = vi.spyOn(console, "error").mockImplementation(() => {}); // the failure is logged by class
        const before = st.fake.batches.length;
        st.fake.failNext(400); // not retryable: a fatal embedder fault
        const id = await idOf(await st.upload(user.cookie, "outage.txt", textOf("Outage")));
        const seen = await st.until(stream, id, (s) => s === "failed");
        stream.close();
        spy.mockRestore();
        expect(seen.at(-1)).toEqual({ documentId: id, status: "failed", detail: "internal" }); // EXECUTION_FAILED names no step
        expect(seen.some((e) => e.step === "embed" && e.status === "embedding")).toBe(true);
        expect(st.fake.batches.length).toBe(before); // the one request was the failure; nothing was retried into an answer
        const doc = await getDoc(user.cookie, id);
        expect([doc.status, doc.error]).toEqual(["failed", STATUS_MESSAGES.internal]);
        await assertLogContentFree(user, id);
      },
      WAIT,
    );

    it(
      "deleting a ready document removes its chunks, vectors, parse and blob, and tombstones its status",
      async () => {
        const user = await st.signUpAndLogIn("delete@example.com");
        const stream = await st.events(user.cookie);
        const id = await idOf(await st.upload(user.cookie, "gone.txt", textOf("Vanishing")));
        await st.until(stream, id, (s) => s === "ready");
        stream.close();
        expect(await countOf("chunks", id)).toBeGreaterThan(1);
        expect(filesOf(user.userId).length).toBe(1);
        expect((await del(user.cookie, id)).status).toBe(204);
        for (const table of ["documents", "chunks", "parsed_documents"])
          expect(await countOf(table, id)).toBe(0); // embeddings live in chunks
        expect(filesOf(user.userId)).toEqual([]);
        await expectTombstoned(id);
        expect((await getDoc(user.cookie, id)) as unknown).toMatchObject({
          error: { code: "not_found" },
        });
        await assertLogContentFree(user, id);
      },
      WAIT,
    );

    it(
      "a delete while the embed step is in flight cancels the execution and leaves no rows or vectors behind",
      async () => {
        const user = await st.signUpAndLogIn("race@example.com");
        const arrived = st.fake.hold(); // the next embed request parks at the gate
        const id = await idOf(await st.upload(user.cookie, "race.txt", textOf("Racing")));
        await arrived; // the embed step is now waiting on the embedder, its chunks already written
        expect(await countOf("chunks", id)).toBeGreaterThan(1);
        expect((await del(user.cookie, id)).status).toBe(204);
        st.fake.release();
        // Loom reaches `cancelled` after the step in flight returns and offers no hook to await; the
        // poll is bounded by the test timeout and is a condition, never a sleep.
        await vi.waitFor(async () => {
          const state = await st.composed.app.runtime.loadState(
            ingestExecutionId(user.userId, id),
            {
              principal: { tenant: user.tenantId, actor: user.userId },
            },
          );
          expect(state?.status).toBe("cancelled");
        });
        for (const table of ["documents", "chunks", "parsed_documents"])
          expect(await countOf(table, id)).toBe(0);
        expect(filesOf(user.userId)).toEqual([]);
        await expectTombstoned(id);
        const log = await st.durable.raw.eventStore.read(ingestExecutionId(user.userId, id));
        expect(log.map((e) => e.eventType)).not.toContain("EXECUTION_COMPLETED"); // never ready
        await assertLogContentFree(user, id);
      },
      WAIT,
    );

    // The sweep as main runs it, with a small age so a freshly stranded document is stale at once.
    const sweepArgs = () => ({
      pool: st.app,
      starts: st.composed.starts,
      olderThanMs: 1,
      lookbackMs: 604_800_000,
      limit: 10,
    });
    const backdate = (id: string) =>
      st.db.owner.query(
        "UPDATE documents SET created_at = now() - interval '10 minutes' WHERE id = $1",
        [id],
      );

    it(
      "the sweep starts a document stranded in uploaded and it reaches ready",
      async () => {
        const user = await st.signUpAndLogIn("sweep@example.com");
        const stream = await st.events(user.cookie);
        // Written the way an upload would, but with no flow start: store the blob, insert the row.
        const store = new EncryptedFsContentStore({
          root: st.root,
          tenantId: user.tenantId,
          userId: user.userId,
          keys: st.keys,
          maxBytes: 1 << 20,
        });
        const bytes = textOf("Stranded");
        const ref = await store.put(bytes);
        const doc = await newDocument(st.fields, user.tenantId, user.userId, "9".repeat(64), {
          contentAddress: ref.__loomContent,
          mime: "text/plain",
          sizeBytes: bytes.length,
        });
        await withTenant(st.app, user.tenantId, (tx) => insertDocument(tx, doc));
        await backdate(doc.id);
        expect((await getDoc(user.cookie, doc.id)).status).toBe("uploaded");
        expect(await sweepStaleUploads(sweepArgs())).toBe(1);
        const seen = await st.until(stream, doc.id, (s) => s === "ready");
        stream.close();
        expect(seen.at(-1)?.status).toBe("ready");
        await st.composed.starts.idle();
        // It has a status row now, so no later sweep asks for it (nor for any other document of this run).
        expect(await sweepStaleUploads(sweepArgs())).toBe(0);
        await assertLogContentFree(user, doc.id);
      },
      WAIT,
    );

    it(
      "the sweep recovers a document whose start FAILED (not just one never started) to ready",
      async () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        const user = await st.signUpAndLogIn("failedstart@example.com");
        const stream = await st.events(user.cookie);
        st.failNextStart();
        const id = await idOf(await st.upload(user.cookie, "failedstart.txt", textOf("Failed")));
        await st.composed.starts.idle(); // the failed start has settled: no execution exists
        expect(errors).toHaveBeenCalledWith("ingest start failed", "Error", "POST /api/documents");
        errors.mockRestore();
        expect((await getDoc(user.cookie, id)).status).toBe("uploaded");
        await backdate(id);
        expect(await sweepStaleUploads(sweepArgs())).toBe(1);
        const seen = await st.until(stream, id, (s) => s === "ready");
        stream.close();
        expect(seen.at(-1)?.status).toBe("ready");
        await st.composed.starts.idle();
        expect(await sweepStaleUploads(sweepArgs())).toBe(0); // it has a status row now
        await assertLogContentFree(user, id);
      },
      WAIT,
    );

    it(
      "a live document whose blob file is missing ends failed/internal instead of stuck",
      async () => {
        const user = await st.signUpAndLogIn("lostblob@example.com");
        const stream = await st.events(user.cookie);
        const store = new EncryptedFsContentStore({
          root: st.root,
          tenantId: user.tenantId,
          userId: user.userId,
          keys: st.keys,
          maxBytes: 1 << 20,
        });
        const bytes = textOf("Lostblob");
        const ref = await store.put(bytes);
        const doc = await newDocument(st.fields, user.tenantId, user.userId, "8".repeat(64), {
          contentAddress: ref.__loomContent,
          mime: "text/plain",
          sizeBytes: bytes.length,
        });
        await withTenant(st.app, user.tenantId, (tx) => insertDocument(tx, doc));
        for (const f of filesOf(user.userId)) rmSync(join(f.parentPath ?? "", f.name));
        expect(filesOf(user.userId)).toEqual([]);
        await backdate(doc.id);
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(await sweepStaleUploads(sweepArgs())).toBe(1);
        const seen = await st.until(stream, doc.id, (s) => s === "failed" || s === "ready");
        stream.close();
        spy.mockRestore();
        expect(seen.at(-1)).toEqual({ documentId: doc.id, status: "failed", detail: "internal" });
        const row = await getDoc(user.cookie, doc.id);
        expect([row.status, row.error]).toEqual(["failed", STATUS_MESSAGES.internal]);
        await assertLogContentFree(user, doc.id);
      },
      WAIT,
    );

    it(
      "the sweep does not restart a document that recovery gave up on",
      async () => {
        const user = await st.signUpAndLogIn("giveup@example.com");
        const stream = await st.events(user.cookie);
        const arrived = st.fake.hold();
        const id = await idOf(await st.upload(user.cookie, "giveup.txt", textOf("Giveup")));
        await arrived; // the embed step is in flight
        // What recovery does to an execution it cannot resume: cancel it with the fixed reason.
        const runtime = st.composed.app.runtime;
        await runtime.cancel(
          ingestExecutionId(user.userId, id),
          FLOW_MISMATCH_REASON,
          runtime.systemOptions(),
        );
        st.fake.release();
        const seen = await st.until(stream, id, (s) => s === "failed");
        stream.close();
        expect(seen.at(-1)).toEqual({ documentId: id, status: "failed", detail: "internal" });
        await backdate(id);
        expect(await sweepStaleUploads(sweepArgs())).toBe(0); // failed is final: nothing is fired
        await st.composed.starts.idle();
        const doc = await getDoc(user.cookie, id);
        expect([doc.status, doc.error]).toEqual(["failed", STATUS_MESSAGES.internal]);
        await assertLogContentFree(user, id);
      },
      WAIT,
    );
  },
);
