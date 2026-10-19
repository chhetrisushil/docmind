import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedFsContentStore } from "@docmind/blob-store";
import { EmbeddingUnavailableError } from "@docmind/embeddings";
import { type FakeOllama, startFakeOllama } from "@docmind/embeddings/testing";
import { ParseAbortedError, ParseRejectedError } from "@docmind/parsers";
import type { EventEnvelope } from "@loom/core";
import { flow$, step$ } from "@loom/core";
import { EmbeddingError, type EmbeddingProvider } from "@loom/memory";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../config";
import { setRolePassword } from "../../db/migrate";
import { withTenant } from "../../db/tenant";
import { LOOM_PASSWORD, PG_URL } from "../../db/testSupport";
import { ingestExecutionId, loomIngest } from "../../documents/ingest";
import { insertDocument } from "../../documents/repo";
import { T1, U1, newDocument, twinOverPgChunks } from "../../documents/testHarness";
import { foldIngestStatus } from "../../status/model";
import { openDurableStorage } from "../../storage";
import type { IngestDeps } from "./deps";
import {
  type INGEST_STEPS,
  IngestOutput,
  type IngestStartInput,
  ingestDocumentFlow,
  ingestParseStep,
  runIngestSteps,
} from "./flow";
import { createIngestWiring } from "./limits";
import { PgChunkStore } from "./pgChunks";
import { pgIngestDeps } from "./pgDeps";
import { type PgFixture, startPgFixture } from "./pgFixture";
import { recoverIngest } from "./recovery";
import { type RawEvent, assertEventsAreContentFree } from "./testing";

const SENTENCE = "Nocturne quarterly revenue forecast: seventeen thousand dollars";
/** A flow that ends at its first step (a gone document). */
const CLEAN_RUN = [
  "EXECUTION_STARTED",
  "STEP_STARTED",
  "RESOURCE_METERED",
  "STEP_COMPLETED",
  "EXECUTION_COMPLETED",
];
const DONE_STEP = ["STEP_STARTED", "RESOURCE_METERED", "STEP_COMPLETED"];
/** Parse, chunk, then embed, all done. */
const FULL_RUN = [
  "EXECUTION_STARTED",
  ...DONE_STEP,
  ...DONE_STEP,
  ...DONE_STEP,
  "EXECUTION_COMPLETED",
];

describe.skipIf(!PG_URL)(
  "the ingest event log holds ids, counts and codes only (needs DOCMIND_TEST_PG_URL)",
  () => {
    let f: PgFixture;
    let durable: Awaited<ReturnType<typeof openDurableStorage>>;
    let app: ReturnType<typeof buildApp>;
    let root: string;
    let fake: FakeOllama;
    let wiring: ReturnType<typeof createIngestWiring>;
    let embedder: EmbeddingProvider; // each test may swap the embedder
    let modelId = "";
    let runner: IngestDeps["runner"]; // each test may swap the parser runner
    const blobs = (id: { tenantId: string; userId: string }) =>
      new EncryptedFsContentStore({
        root,
        tenantId: id.tenantId,
        userId: id.userId,
        keys: f.keys,
        maxBytes: 1 << 20,
      });

    beforeAll(async () => {
      fake = await startFakeOllama({ dimensions: 64, model: "fake-embed" });
      wiring = createIngestWiring({
        DOCMIND_OLLAMA_URL: fake.url,
        DOCMIND_EMBED_MODEL: "fake-embed",
        DOCMIND_EMBED_DIMENSIONS: "64",
      });
      wiring.sleep = async () => {}; // retries do not wait
      runner = wiring.runner;
      embedder = wiring.embedder;
      modelId = wiring.embedder.modelId;
      f = await startPgFixture();
      await setRolePassword(f.db.owner, "docmind_loom", LOOM_PASSWORD);
      durable = await openDurableStorage({ loomUrl: f.db.loomUrl, keys: f.keys });
      root = mkdtempSync(join(tmpdir(), "dm-eventlog-"));
      const base = pgIngestDeps({
        pool: f.app,
        fields: f.fields,
        blobs,
        wiring,
        vectors: twinOverPgChunks(f.app, wiring),
      });
      app = buildApp(durable.storage, durable.crypto, {
        ingest: {
          ...base,
          runner: { run: (...args) => runner.run(...args) },
          embedder: {
            modelId: base.embedder.modelId,
            dimensions: base.embedder.dimensions,
            embed: (texts, options) => embedder.embed(texts, options),
          },
        },
      });
    });
    afterEach(() => {
      runner = wiring.runner;
      embedder = wiring.embedder;
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      await app?.close();
      await wiring.runner.close();
      await durable?.close();
      await f?.close();
      await fake?.close();
      if (root) rmSync(root, { recursive: true, force: true });
    });

    /** A txt document of ALICE whose text is `SENTENCE` repeated, its blob stored as an upload leaves it. */
    async function seedTxt(fingerprint: string): Promise<IngestStartInput> {
      const bytes = Buffer.from(Array.from({ length: 4 }, () => SENTENCE).join("\n\n"));
      const ref = await blobs({ tenantId: T1, userId: U1 }).put(bytes);
      const doc = await newDocument(f.fields, T1, U1, fingerprint, {
        contentAddress: ref.__loomContent,
        mime: "text/plain",
        sizeBytes: bytes.length,
      });
      await withTenant(f.app, T1, (tx) => insertDocument(tx, doc));
      return { tenantId: T1, userId: U1, documentId: doc.id };
    }
    const start = (ref: IngestStartInput) =>
      app.runtime.start(ingestDocumentFlow, ref, {
        executionId: ingestExecutionId(ref.userId, ref.documentId),
        principal: { tenant: ref.tenantId, actor: ref.userId },
      });
    const log = (ref: IngestStartInput) =>
      durable.raw.eventStore.read(ingestExecutionId(ref.userId, ref.documentId));
    const run = async (ref: IngestStartInput) => {
      await start(ref).then((h) => h.waitForCompletion().catch(() => undefined));
      return log(ref);
    };
    /** Every event passes the structural check, and none of the seeded text is in the raw JSON. */
    const proven = (raw: EventEnvelope[], ref: IngestStartInput) => {
      assertEventsAreContentFree(raw as RawEvent[], ref, modelId);
      const json = JSON.stringify(raw);
      for (const text of [SENTENCE.slice(0, 30), "Quarterly report", "Quarterly report.pdf"]) {
        expect(json).not.toContain(text); // meaningful: raw events are plain JSON, so a leak would show
      }
      return raw;
    };
    const types = (raw: { eventType: string }[]) => raw.map((e) => e.eventType);

    it("a successful parse, chunk and embed: ids, an outcome and a count only; the text is only in the sealed chunks", async () => {
      const ref = await seedTxt("a".repeat(64));
      const raw = proven(await run(ref), ref);
      expect(types(raw)).toEqual(FULL_RUN);
      expect(raw[3]?.payload).toEqual({
        output: { outcome: "done", count: 1 },
        stepId: "ingest-parse",
      });
      expect(raw[6]?.payload).toEqual({
        output: { outcome: "done", count: 1 },
        stepId: "ingest-chunk",
      });
      expect(raw[9]?.payload).toEqual({
        output: { outcome: "done", count: 1, model: "ollama/fake-embed" },
        stepId: "ingest-embed",
      });
      expect(foldIngestStatus(raw)).toEqual({ status: "embedding", step: "embed", code: null }); // the model's handlers match the kernel's real events
      const chunked = await f.db.owner.query(
        "SELECT count(*)::int AS n FROM chunks WHERE document_id = $1",
        [ref.documentId],
      );
      expect(chunked.rows[0].n).toBeGreaterThanOrEqual(1);
      const left = await f.db.owner.query("SELECT 1 FROM parsed_documents WHERE document_id = $1", [
        ref.documentId,
      ]);
      expect(left.rowCount).toBe(0); // the parsed row is dropped once the chunks exist
      const row = await f.db.owner.query(
        "SELECT id, text_enc FROM chunks WHERE document_id = $1 ORDER BY ordinal",
        [ref.documentId],
      );
      expect(row.rows[0].text_enc.__loomEnc).toBe("loom/aes-256-gcm");
      const opened = await new PgChunkStore(f.app, f.fields).read(ref, [row.rows[0].id]);
      expect(opened[0]?.text).toContain(SENTENCE.slice(0, 30)); // opens for its owner
    });

    it("a permanent failure by mime leaves a code in the log, not a message", async () => {
      const ref = await seedTxt("b".repeat(64));
      await f.db.owner.query("UPDATE documents SET mime = 'application/x-nothing' WHERE id = $1", [
        ref.documentId,
      ]);
      const raw = proven(await run(ref), ref);
      expect(raw.at(-1)?.payload).toEqual({
        output: { outcome: "failed", code: "unsupported_content" },
      });
      expect(foldIngestStatus(raw)).toEqual({
        status: "failed",
        step: "parse",
        code: "unsupported_content",
      });
    });

    it("a permanent failure by a parser reject code: the code only, never the parser's message", async () => {
      runner = {
        run: async () => {
          throw new ParseRejectedError("corrupt_content");
        },
      };
      const ref = await seedTxt("c".repeat(64));
      const raw = proven(await run(ref), ref);
      expect(raw.at(-1)?.payload).toEqual({
        output: { outcome: "failed", code: "corrupt_content" },
      });
      expect(foldIngestStatus(raw)).toMatchObject({ status: "failed", code: "corrupt_content" });
    });

    it("a transient failure that is retried leaves no trace of the attempts, and not the error text", async () => {
      let attempts = 0;
      runner = {
        run: async () => {
          if (++attempts < 3) throw new Error(`crash while reading ${SENTENCE}`);
          return { text: "h", sections: [], media: [] };
        },
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      const ref = await seedTxt("d".repeat(64));
      const raw = proven(await run(ref), ref);
      expect(attempts).toBe(3); // the retries are in memory: the same events as a clean run
      expect(types(raw)).toEqual(FULL_RUN);
    });

    it("a transient failure that exhausts its retries records a fixed message, not the error text", async () => {
      runner = {
        run: async () => {
          throw new Error(`crash while reading ${SENTENCE}`);
        },
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      const ref = await seedTxt("e".repeat(64));
      const raw = proven(await run(ref), ref);
      expect(types(raw).slice(-2)).toEqual(["STEP_FAILED", "EXECUTION_FAILED"]);
      expect(raw.at(-1)?.payload).toEqual({ error: "Error: ingest step failed: parse" });
      expect(foldIngestStatus(raw)).toMatchObject({ status: "failed", code: "internal" });
    });

    it("a transient embed outage that is retried leaves no trace of the attempts, and not the error text", async () => {
      let attempts = 0;
      embedder = {
        modelId: wiring.embedder.modelId,
        dimensions: wiring.embedder.dimensions,
        embed: async (texts, options) => {
          if (++attempts < 2)
            throw Object.assign(new EmbeddingUnavailableError(), {
              message: `down while embedding ${SENTENCE}`,
            });
          return wiring.embedder.embed(texts, options);
        },
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      const ref = await seedTxt("7".repeat(64));
      const raw = proven(await run(ref), ref);
      expect(attempts).toBe(2);
      expect(types(raw)).toEqual(FULL_RUN);
      expect(raw[9]?.payload).toMatchObject({ output: { model: modelId }, stepId: "ingest-embed" });
    });

    it("a fatal embedding error records a fixed message, not the error text, and the document fails as internal", async () => {
      embedder = {
        modelId: wiring.embedder.modelId,
        dimensions: wiring.embedder.dimensions,
        embed: async () => {
          throw new EmbeddingError(`rejected ${SENTENCE}`);
        },
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      const ref = await seedTxt("8".repeat(64));
      const raw = proven(await run(ref), ref);
      expect(types(raw).slice(-2)).toEqual(["STEP_FAILED", "EXECUTION_FAILED"]);
      expect(raw.at(-1)?.payload).toEqual({ error: "Error: ingest step failed: embed" });
      expect(foldIngestStatus(raw)).toMatchObject({ status: "failed", code: "internal" });
    });

    it("a document that is gone ends with an outcome and nothing else", async () => {
      const ref = await seedTxt("f".repeat(64));
      await f.db.owner.query("DELETE FROM documents WHERE id = $1", [ref.documentId]);
      const raw = proven(await run(ref), ref);
      expect(raw.at(-1)?.payload).toEqual({ output: { outcome: "document_gone" } });
    });

    it("a document that goes away between two attempts of a retried step ends the same way", async () => {
      const ref = await seedTxt("9".repeat(64));
      runner = {
        run: async () => {
          await f.db.owner.query("DELETE FROM documents WHERE id = $1", [ref.documentId]);
          throw new Error(`crash while reading ${SENTENCE}`);
        },
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      const raw = proven(await run(ref), ref);
      expect(types(raw)).toEqual(CLEAN_RUN);
      expect(raw.at(-2)?.payload).toEqual({
        output: { outcome: "document_gone" },
        stepId: "ingest-parse",
      });
    });

    it("a user cancel (a delete) records only its fixed reason", async () => {
      let inRun: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        inRun = resolve;
      });
      runner = {
        run: (_id, _bytes, options) =>
          new Promise((_, reject) => {
            inRun();
            options?.signal?.addEventListener("abort", () => reject(new ParseAbortedError()));
          }),
      };
      const ref = await seedTxt("1".repeat(64));
      await start(ref);
      await entered;
      await loomIngest(app.runtime).cancel({ tenantId: T1, userId: U1 }, ref.documentId);
      // Loom appends the cancel, then the step's, after cancel() returns: wait on the log (bounded), then assert.
      await vi.waitFor(async () =>
        expect((await log(ref)).map((e) => e.eventType)).toContain("STEP_CANCELLED"),
      );
      const raw = proven(await log(ref), ref);
      expect(raw.at(-2)?.payload).toEqual({ reason: "document-deleted" });
      expect(raw.at(-1)?.payload).toEqual({ stepId: "ingest-parse" });
    });

    /** A process over the shared database with its own Loom pool, as after a restart. */
    const peers: (() => Promise<unknown>)[] = [];
    afterAll(async () => {
      for (const close of peers.reverse()) await close().catch(() => {});
    });
    async function peer(run: IngestDeps["runner"]["run"], over: Partial<IngestDeps> = {}) {
      const d = await openDurableStorage({ loomUrl: f.db.loomUrl, keys: f.keys });
      const base = pgIngestDeps({
        pool: f.app,
        fields: f.fields,
        blobs,
        wiring,
        vectors: twinOverPgChunks(f.app, wiring),
      });
      const a = buildApp(d.storage, d.crypto, {
        ingest: { ...base, runner: { run }, ...over },
      });
      peers.push(async () => {
        await a.close();
        await d.close();
      });
      return { app: a, source: d.storage.eventStore };
    }
    const never = () => new Promise<never>(() => {});
    /** Starts `ref` on a process that then "crashes" in its step: its lease is released, the step never ends. */
    async function crashed(ref: IngestStartInput, flow = ingestDocumentFlow) {
      let inStep: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        inStep = resolve;
      });
      const origin = await peer(() => {
        inStep();
        return never();
      });
      origin.app.runtime.registerFlow(flow.definition, flow.runner);
      await origin.app.runtime.start(flow, ref, {
        executionId: ingestExecutionId(ref.userId, ref.documentId),
        principal: { tenant: ref.tenantId, actor: ref.userId },
      });
      await entered;
      await origin.app.runtime.closeHeartbeat();
    }

    it("a recovery cancel (crash loop past its bound) records only its fixed reason", async () => {
      const ref = await seedTxt("2".repeat(64));
      await crashed(ref);
      let redriven: () => void = () => {};
      const second = new Promise<void>((resolve) => {
        redriven = resolve;
      });
      const one = await peer(() => {
        redriven();
        return never();
      });
      const opts = { graceMs: 0, maxRecoveries: 1 };
      void recoverIngest(one.app.runtime, one.source, opts);
      await second; // the first re-drive is running and hangs again
      await one.app.runtime.closeHeartbeat();
      const two = await peer(never);
      expect(await recoverIngest(two.app.runtime, two.source, opts)).toMatchObject({
        exhausted: 1,
      });
      const raw = proven(await log(ref), ref);
      expect(types(raw)).toContain("EXECUTION_RECOVERED");
      expect(raw.at(-1)?.payload).toEqual({ reason: "ingest-recovery-exhausted" });
      expect(foldIngestStatus(raw)).toMatchObject({ status: "failed", code: "internal" });
    });

    it("a recovery cancel for a flow whose identity changed records only its fixed reason", async () => {
      // The flow as an earlier deploy defined it: the same step with another retry policy (part of the flow hash).
      const oldSteps = [
        step$({ ...ingestParseStep, retry: { maxAttempts: 5 } }),
      ] as unknown as typeof INGEST_STEPS;
      const old = {
        runner: runIngestSteps(oldSteps) as never,
        definition: flow$({
          id: "ingest-document",
          name: "IngestDocument",
          version: "1.9.0",
          inputSchema: ingestDocumentFlow.definition.inputSchema,
          outputSchema: IngestOutput,
          steps: oldSteps,
        }),
      };
      const ref = await seedTxt("3".repeat(64));
      await crashed(ref, old);
      vi.spyOn(console, "error").mockImplementation(() => {});
      const next = await peer(never);
      expect(await recoverIngest(next.app.runtime, next.source, { graceMs: 0 })).toMatchObject({
        failed: 1,
      });
      const raw = proven(await log(ref), ref);
      expect(raw.at(-1)?.payload).toEqual({ reason: "ingest-flow-mismatch" });
      expect(foldIngestStatus(raw)).toMatchObject({ status: "failed", code: "internal" });
    });

    it("a recovery re-run that succeeds leaves the recovery marker and a normal finish", async () => {
      const ref = await seedTxt("4".repeat(64));
      await crashed(ref);
      const next = await peer(async () => ({ text: "h", sections: [], media: [] }));
      expect(await recoverIngest(next.app.runtime, next.source, { graceMs: 0 })).toMatchObject({
        recovered: 1,
        failed: 0,
      });
      const raw = proven(await log(ref), ref);
      expect(types(raw)).toEqual([
        "EXECUTION_STARTED",
        "STEP_STARTED",
        "EXECUTION_RECOVERED",
        ...DONE_STEP,
        ...DONE_STEP,
        ...DONE_STEP,
        "EXECUTION_COMPLETED",
      ]);
    });

    it("a shutdown interrupt records nothing; the next boot's recovery then finishes the step", async () => {
      const ref = await seedTxt("5".repeat(64));
      const shutdown = new AbortController();
      let inStep: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        inStep = resolve;
      });
      const origin = await peer(
        () =>
          new Promise<never>((_, reject) => {
            inStep();
            shutdown.signal.addEventListener("abort", () => reject(new ParseAbortedError()));
          }),
        { shutdown: shutdown.signal },
      );
      await origin.app.runtime.start(ingestDocumentFlow, ref, {
        executionId: ingestExecutionId(ref.userId, ref.documentId),
        principal: { tenant: ref.tenantId, actor: ref.userId },
      });
      await entered;
      shutdown.abort(); // the step is interrupted, not failed: it stays un-completed in the log
      await origin.app.runtime.closeHeartbeat();
      expect(types(proven(await log(ref), ref))).toEqual(["EXECUTION_STARTED", "STEP_STARTED"]);
      const next = await peer(async () => ({ text: "h", sections: [], media: [] }));
      await recoverIngest(next.app.runtime, next.source, { graceMs: 0 });
      const raw = proven(await log(ref), ref);
      expect(types(raw).at(-1)).toBe("EXECUTION_COMPLETED");
      expect(types(raw)).toContain("EXECUTION_RECOVERED");
    });

    it("a cancel by another user is denied and recorded with fixed text only", async () => {
      const ref = await seedTxt("6".repeat(64));
      await crashed(ref); // a live-looking execution to aim at
      const executionId = ingestExecutionId(ref.userId, ref.documentId);
      await app.runtime
        .cancel(executionId, "user asked for it: Q3 report.pdf", {
          principal: { tenant: ref.tenantId, actor: "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1" },
        })
        .catch(() => undefined);
      const raw = proven(await log(ref), ref);
      expect(raw.at(-1)).toMatchObject({
        eventType: "EXECUTION_DENIED",
        payload: { op: "cancel", reason: "only the execution's owner may do this" },
      });
      expect(JSON.stringify(raw)).not.toContain("user asked for it"); // the caller's reason is not recorded
    });
  },
);
