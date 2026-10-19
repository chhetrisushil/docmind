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
import { ingestExecutionId } from "./ingest";
import { type IngestStack, startIngestStack } from "./ingestStack";
import { PDF } from "./testHarness";

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
      "ends a pdf as failed with unsupported_content until part 2 adds the parser",
      async () => {
        const user = await st.signUpAndLogIn("pdf@example.com");
        const stream = await st.events(user.cookie);
        const id = await idOf(await st.upload(user.cookie, "report.pdf", PDF("acceptance")));
        const seen = await st.until(stream, id, (s) => s === "failed");
        stream.close();
        expect(seen.at(-1)).toEqual({
          documentId: id,
          step: "parse",
          status: "failed",
          detail: "unsupported_content",
        });
        expect((await getDoc(user.cookie, id)).error).toBe(STATUS_MESSAGES.unsupported_content);
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
  },
);
