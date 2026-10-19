import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { InMemoryReadModelStore } from "@loom/plugin-read-model";
import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../compose";
import { ingestExecutionId, ingestStartInput } from "../documents/ingest";
import { loadBlobRoot, loadLimits } from "../documents/limits";
import { ingestDocumentFlow } from "../flows/ingest-document/flow";
import { createIngestWiring } from "../flows/ingest-document/limits";
import { SENSITIVE_EVENT_PATHS } from "../sensitive";
import { subjectOfExecution } from "../subject";
import { STATUS_MESSAGES } from "./model";

const root = mkdtempSync(join(tmpdir(), "dm-compose-status-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Records the fold version the service registers with. */
class RecordingStore extends InMemoryReadModelStore {
  readonly registeredVersions: string[] = [];
  override async beginFold(modelId: string, foldVersion: string) {
    this.registeredVersions.push(foldVersion);
    return super.beginFold(modelId, foldVersion);
  }
}

function compose() {
  // The encrypting store the app uses in production, over an in-memory log: its sealing covers feed the map.
  const events = new EncryptingEventStore(new InMemoryAsyncEventStore(), new InMemoryKeyStore(), {
    sensitive: { ...SENSITIVE_EVENT_PATHS },
    subjectOf: subjectOfExecution,
  });
  const store = new RecordingStore();
  const composed = buildServer({
    pool: {} as Pool, // never reached: the flow fails at its first step
    keys: new InMemoryKeyStore(),
    storage: { kind: "custom", eventStore: events },
    crypto: { events },
    limits: loadLimits({}),
    blobRoot: loadBlobRoot({ DOCMIND_BLOB_DIR: root }),
    secureCookies: false,
    trustProxy: false,
    ingest: { ...createIngestWiring({}), sleep: async () => {} }, // no real backoff on the failing guard
    status: { writer: store, readerFor: () => store, source: events },
  });
  return { composed, store };
}

async function runFailingIngest(composed: ReturnType<typeof compose>["composed"]) {
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
  // The parse step's guard cannot reach the stub pool: its existence check fails with the fixed message
  // (`document existence check failed`) before any work, so the execution fails: pin that it rejects with an Error.
  await expect(handle.waitForCompletion()).rejects.toBeInstanceOf(Error);
  return { identity, documentId };
}

describe("buildServer and the ingest-status model", () => {
  it("registers the model under the sensitive map computed from the sealing store, not the declared version alone", async () => {
    const { composed, store } = compose();
    await composed.status.boot();
    // `effectiveFoldVersion` appends a digest of the sensitive map; "2" alone means the map was empty.
    expect(store.registeredVersions).toHaveLength(1);
    expect(store.registeredVersions[0]).toMatch(/^2\+sens\.[0-9a-f]{8}$/);
    await composed.status.close();
    await composed.app.close();
  });

  it("folds an execution from Loom's onEvent after boot", async () => {
    const { composed } = compose();
    await composed.status.boot();
    const { identity, documentId } = await runFailingIngest(composed);
    await composed.status.close();
    const views = await composed.status.forPage(identity, [documentId]);
    expect(views.get(documentId)).toMatchObject({
      status: "failed",
      error: STATUS_MESSAGES.internal,
    });
    await composed.app.close();
  });

  it("stops folding once the feed is detached", async () => {
    const { composed } = compose();
    await composed.status.boot();
    composed.detachStatusFeed();
    const { identity, documentId } = await runFailingIngest(composed);
    await composed.status.close();
    expect((await composed.status.forPage(identity, [documentId])).size).toBe(0);
    await composed.app.close();
  });

  it("mounts the progress stream and returns events, whose closeAll shutdown calls", async () => {
    const { composed } = compose();
    await new Promise<void>((resolve) => composed.server.listen(0, "127.0.0.1", resolve));
    const { port } = composed.server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/documents/events`);
    expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([
      401,
      "unauthorized",
    ]);
    expect(typeof composed.events.closeAll).toBe("function");
    await new Promise<void>((resolve) => composed.server.close(() => resolve()));
    await composed.status.close();
    await composed.app.close();
  });
});
