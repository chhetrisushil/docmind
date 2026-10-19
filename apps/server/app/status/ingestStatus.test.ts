import { randomUUID } from "node:crypto";
import type { Identity } from "@docmind/auth";
import { InMemoryReadModelStore } from "@loom/plugin-read-model";
import { describe, expect, it } from "vitest";
import { ingestExecutionId } from "../documents/ingest";
import { IngestStatus, type IngestStatusOptions } from "./ingestStatus";
import { INGEST_STATUS_MODEL, STATUS_MESSAGES, UPLOADED } from "./model";
import { MemoryLog, ingestRun } from "./testing";

const U = randomUUID();
const [D1, D2] = [randomUUID(), randomUUID()];
const ALICE: Identity = { tenantId: randomUUID(), userId: U };
const exec = (documentId: string) => ingestExecutionId(U, documentId);

function setup(over: Partial<IngestStatusOptions> = {}) {
  const store = new InMemoryReadModelStore();
  const log = new MemoryLog();
  const errors: unknown[] = [];
  const status = new IngestStatus({
    writer: store,
    readerFor: () => store,
    source: log,
    sensitive: {},
    onError: (e) => errors.push(e),
    ...over,
  });
  /** What Loom does: persist the event, then call onEvent. */
  const feed = (...events: ReturnType<typeof ingestRun>) => {
    for (const e of events) {
      log.append(e);
      status.onEvent(e);
    }
  };
  return { store, log, errors, status, feed };
}

describe("IngestStatus", () => {
  it("boot registers the model and catches up what the log holds from before", async () => {
    const { log, status, errors } = setup();
    log.append(...ingestRun(exec(D1), "ready"), ...ingestRun(exec(D2), "failed:too_large"));
    expect(await status.boot()).toMatchObject({ executionsScanned: 2 });
    const views = await status.forPage(ALICE, [D1, D2]);
    expect(views.get(D1)).toEqual({ status: "ready", step: "finalize", error: null });
    expect(views.get(D2)).toEqual({
      status: "failed",
      step: "parse",
      error: STATUS_MESSAGES.too_large,
    });
    expect(errors).toEqual([]);
  });

  it("folds the live feed after boot", async () => {
    const { status, feed } = setup();
    await status.boot();
    feed(...ingestRun(exec(D1), "parsed"));
    await status.close();
    expect((await status.forPage(ALICE, [D1])).get(D1)).toMatchObject({
      status: "parsing",
      step: "parse",
    });
  });

  it("forPage is one plain read; forDocument first folds the log tail the live feed missed, and an unknown document is uploaded", async () => {
    const { log, status } = setup();
    await status.boot();
    log.append(...ingestRun(exec(D1), "ready")); // persisted, but onEvent never saw it
    expect((await status.forPage(ALICE, [D1])).size).toBe(0);
    expect(await status.forDocument(ALICE, D1)).toEqual({
      status: "ready",
      step: "finalize",
      error: null,
    });
    expect(await status.forDocument(ALICE, D2)).toEqual(UPLOADED);
  });

  it("takes the highest generation of a document", async () => {
    const { log, status } = setup();
    const gen1 = `u_${U}:ingest-${D1}`; // the M2 stub's bare name
    const gen2 = `u_${U}:ingest-${D1}.2`;
    log.append(
      ...ingestRun(gen1, "started"),
      ...ingestRun(gen2, "parsed"),
      ...ingestRun(`u_${U}:ingest-${D2}`, "started"),
    );
    await status.boot();
    const views = await status.forPage(ALICE, [D1, D2]);
    expect([views.get(D1)?.status, views.get(D2)]).toEqual(["parsing", UPLOADED]);
  });

  it("scopes to the owner: another user of the same tenant sees nothing, and ids are case-insensitive", async () => {
    const { status, feed } = setup();
    await status.boot();
    feed(...ingestRun(exec(D1), "ready"));
    await status.close();
    const bob: Identity = { tenantId: ALICE.tenantId, userId: randomUUID() };
    expect((await status.forPage(bob, [D1])).size).toBe(0);
    expect(await status.forDocument(bob, D1)).toEqual(UPLOADED);
    const upper = D1.toUpperCase();
    expect((await status.forPage(ALICE, [upper])).get(upper)).toMatchObject({ status: "ready" });
  });

  it("boot rejects when catch-up fails", async () => {
    class Failing extends InMemoryReadModelStore {
      override async applyFolded(...a: Parameters<InMemoryReadModelStore["applyFolded"]>) {
        if (a.length >= 0) throw new RangeError("store down");
        return super.applyFolded(...a);
      }
    }
    const store = new Failing();
    const { log, status } = setup({ writer: store, readerFor: () => store });
    log.append(...ingestRun(exec(D1), "ready"));
    await expect(status.boot()).rejects.toBeInstanceOf(RangeError);
  });

  it("reports a failed live fold to onError as the error alone, never the event", async () => {
    class Failing extends InMemoryReadModelStore {
      failing = false;
      override async applyFolded(...a: Parameters<InMemoryReadModelStore["applyFolded"]>) {
        if (this.failing) throw new RangeError("store down");
        return super.applyFolded(...a);
      }
    }
    const store = new Failing();
    const calls: unknown[][] = [];
    const { status, feed } = setup({
      writer: store,
      readerFor: () => store,
      onError: (...args: unknown[]) => calls.push(args),
    });
    await status.boot();
    store.failing = true;
    feed(...ingestRun(exec(D1), "parsed"));
    await status.close();
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args).toHaveLength(1);
      expect(args[0]).toBeInstanceOf(RangeError);
    }
  });
});
