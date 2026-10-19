import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { InMemoryReadModelStore } from "@loom/plugin-read-model";
import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../compose";
import { ingestExecutionId, ingestStartInput } from "../documents/ingest";
import { loadBlobRoot, loadLimits } from "../documents/limits";
import { ingestDocumentFlow } from "../flows/ingest-document/flow";
import { createIngestWiring } from "../flows/ingest-document/limits";
import { STATUS_MESSAGES } from "./model";

const root = mkdtempSync(join(tmpdir(), "dm-compose-status-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("buildServer and the ingest-status model", () => {
  it("feeds the model from Loom's onEvent and boots it before serving", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const store = new InMemoryReadModelStore();
    const composed = buildServer({
      pool: {} as Pool, // never reached: the flow fails at its first step
      keys: new InMemoryKeyStore(),
      storage: { kind: "custom", eventStore },
      limits: loadLimits({}),
      blobRoot: loadBlobRoot({ DOCMIND_BLOB_DIR: root }),
      secureCookies: false,
      trustProxy: false,
      ingest: createIngestWiring({}),
      status: { writer: store, readerFor: () => store, source: eventStore },
    });
    await composed.status.boot();
    const identity = { tenantId: randomUUID(), userId: randomUUID() };
    const documentId = randomUUID();
    const handle = await composed.app.runtime.start(
      ingestDocumentFlow,
      ingestStartInput(identity, documentId),
      {
        executionId: ingestExecutionId(identity.userId, documentId),
        principal: { tenant: identity.tenantId, actor: identity.userId },
      },
    );
    // The stub step cannot reach the stub pool, so the execution fails: pin that it rejects with an Error.
    await expect(handle.waitForCompletion()).rejects.toBeInstanceOf(Error);
    await composed.status.close();
    const views = await composed.status.forPage(identity, [documentId]);
    expect(views.get(documentId)).toMatchObject({
      status: "failed",
      error: STATUS_MESSAGES.internal,
    });
    await composed.app.close();
  });
});
