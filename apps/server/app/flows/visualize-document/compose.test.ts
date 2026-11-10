import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../compose";
import { loadBlobRoot, loadLimits } from "../../documents/limits";
import { OpaqueIds, opaqueIds } from "../../opaqueIds";
import { AutoHandleStore } from "../../opaqueIds/testing";
import { createIngestWiring } from "../ingest-document/limits";

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  opaqueIds.install(undefined);
});

/** Every query answers no rows (the run's first step fails; the recorder's write succeeds), through a client as `withTenant` expects. */
function fakePool(): Pool {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const client = { query, on: () => client, off: () => client, release: () => undefined };
  return { query, connect: async () => client } as unknown as Pool;
}

describe("compose: the visuals starter and the run recorder", () => {
  it("a visualize run's recorded end reaches the starter (onEnded -> visuals.ended)", async () => {
    const root = mkdtempSync(join(tmpdir(), "dm-compose-visuals-"));
    try {
      const keys = new InMemoryKeyStore();
      const built = buildServer({
        // Every query answers no rows: the run's first step fails, and the recorder's write succeeds.
        pool: fakePool(),
        keys,
        ids: new OpaqueIds(keys, new AutoHandleStore()),
        storage: { kind: "custom", eventStore: new InMemoryAsyncEventStore() },
        limits: loadLimits({}),
        blobRoot: loadBlobRoot({ DOCMIND_BLOB_DIR: root }),
        secureCookies: false,
        trustProxy: false,
        ingest: {
          ...createIngestWiring({
            DOCMIND_VISUALS_PROVIDER: "anthropic",
            ANTHROPIC_API_KEY: "sk-test-not-real",
          }),
          sleep: async () => {},
        },
        status: { source: new InMemoryAsyncEventStore() } as never,
        plannerDecisionKey: KEY,
      });
      closers.push(async () => void (await built.app.close()));
      const ended = vi.spyOn(built.visuals, "ended");
      const ref = { tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() };
      expect(await built.visuals.rerun(ref, 1)).toMatchObject({ kind: "started" }); // a re-run records no execution id first
      await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
      expect(typeof ended.mock.calls[0]?.[0]).toBe("string");
      expect(built.visuals.running(ref, 1)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
