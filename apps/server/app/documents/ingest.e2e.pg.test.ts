import type {
  DocumentDto,
  ListDocumentsResponse,
  UploadDocumentResponse,
} from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { chunkBind } from "../flows/ingest-document/pgChunks";
import { assertEventsAreContentFree } from "../flows/ingest-document/testing";
import { ingestExecutionId } from "./ingest";
import { type IngestStack, startIngestStack } from "./ingestStack";

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
  },
);
