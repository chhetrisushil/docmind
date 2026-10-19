import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedFsContentStore } from "@docmind/blob-store";
import { ParseRejectedError } from "@docmind/parsers";
import type { EventEnvelope } from "@loom/core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../config";
import { setRolePassword } from "../../db/migrate";
import { withTenant } from "../../db/tenant";
import { LOOM_PASSWORD, PG_URL } from "../../db/testSupport";
import { ingestExecutionId } from "../../documents/ingest";
import { insertDocument } from "../../documents/repo";
import { T1, U1, newDocument } from "../../documents/testHarness";
import { foldIngestStatus } from "../../status/model";
import { openDurableStorage } from "../../storage";
import type { IngestDeps } from "./deps";
import { type IngestStartInput, ingestDocumentFlow } from "./flow";
import { createIngestWiring } from "./limits";
import { pgIngestDeps } from "./pgDeps";
import { type PgFixture, startPgFixture } from "./pgFixture";
import { PgParsedStore } from "./pgParsed";
import { type RawEvent, assertEventsAreContentFree } from "./testing";

const SENTENCE = "Nocturne quarterly revenue forecast: seventeen thousand dollars";
const CLEAN_RUN = [
  "EXECUTION_STARTED",
  "STEP_STARTED",
  "RESOURCE_METERED",
  "STEP_COMPLETED",
  "EXECUTION_COMPLETED",
];

describe.skipIf(!PG_URL)(
  "the ingest event log holds ids, counts and codes only (needs DOCMIND_TEST_PG_URL)",
  () => {
    let f: PgFixture;
    let durable: Awaited<ReturnType<typeof openDurableStorage>>;
    let app: ReturnType<typeof buildApp>;
    let root: string;
    const wiring = createIngestWiring({});
    wiring.sleep = async () => {}; // retries do not wait
    let runner: IngestDeps["runner"] = wiring.runner; // each test may swap the parser runner
    const blobs = (id: { tenantId: string; userId: string }) =>
      new EncryptedFsContentStore({
        root,
        tenantId: id.tenantId,
        userId: id.userId,
        keys: f.keys,
        maxBytes: 1 << 20,
      });

    beforeAll(async () => {
      f = await startPgFixture();
      await setRolePassword(f.db.owner, "docmind_loom", LOOM_PASSWORD);
      durable = await openDurableStorage({ loomUrl: f.db.loomUrl, keys: f.keys });
      root = mkdtempSync(join(tmpdir(), "dm-eventlog-"));
      const base = pgIngestDeps({ pool: f.app, fields: f.fields, blobs, wiring });
      app = buildApp(durable.storage, durable.crypto, {
        ingest: { ...base, runner: { run: (...args) => runner.run(...args) } },
      });
    });
    afterEach(() => {
      runner = wiring.runner;
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      await app?.close();
      await wiring.runner.close();
      await durable?.close();
      await f?.close();
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
      assertEventsAreContentFree(raw as RawEvent[], ref);
      const json = JSON.stringify(raw);
      for (const text of [SENTENCE.slice(0, 30), "Quarterly report", "Quarterly report.pdf"]) {
        expect(json).not.toContain(text); // meaningful: raw events are plain JSON, so a leak would show
      }
      return raw;
    };
    const types = (raw: { eventType: string }[]) => raw.map((e) => e.eventType);

    it("a successful parse: ids, an outcome and a count only; the text is only in the sealed row", async () => {
      const ref = await seedTxt("a".repeat(64));
      const raw = proven(await run(ref), ref);
      expect(types(raw)).toEqual(CLEAN_RUN);
      expect(raw[3]?.payload).toEqual({
        output: { outcome: "done", count: 1 },
        stepId: "ingest-parse",
      });
      expect(foldIngestStatus(raw)).toEqual({ status: "parsing", step: "parse", code: null }); // the model's handlers match the kernel's real events
      const row = await f.db.owner.query(
        "SELECT body_enc FROM parsed_documents WHERE document_id = $1",
        [ref.documentId],
      );
      expect(row.rows[0].body_enc.__loomEnc).toBe("loom/aes-256-gcm");
      expect((await new PgParsedStore(f.app, f.fields).take(ref))?.text).toContain(SENTENCE); // opens for its owner
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
  },
);
