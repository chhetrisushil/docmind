import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore, isKeyUnavailable } from "@loom/event-runtime";
import {
  EncryptingEventStore,
  InMemoryKeyStore,
  PayloadShreddedError,
  isShredded,
} from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { executionIdFor, subjectOfExecution } from "../subject";
import { userShredder } from "./compliance";
import { noSnapshots } from "./testing";
import { sensitiveFromCovers, tolerantSource } from "./tolerantSource";

const U = randomUUID();
const EXEC = executionIdFor(U, "ingest-1");
const ev = (sequence: number, eventType: string, payload: unknown): EventEnvelope => ({
  id: `${EXEC}-${sequence}`,
  workflowId: "wf",
  executionId: EXEC,
  eventType,
  sequence,
  timestamp: 1_000 + sequence,
  payload,
});

function setup() {
  const raw = new InMemoryAsyncEventStore();
  const keys = new InMemoryKeyStore();
  const strict = new EncryptingEventStore(raw, keys, {
    sensitive: { NOTE_ADDED: ["text"] },
    subjectOf: subjectOfExecution,
  });
  // Registered after construction, the way `defineConfig` registers the principal paths.
  strict.registerSensitive("OTHER_ADDED", ["body"]);
  return { raw, keys, strict };
}

describe("sensitiveFromCovers", () => {
  it("rebuilds the per-event-type path map from `EVENT_TYPE.path` covers", () => {
    expect(sensitiveFromCovers(["A.x", "A.y.z", "B.q[].r", "malformed", ".alsoBad"])).toEqual({
      A: ["x", "y.z"],
      B: ["q[].r"],
    });
  });
});

describe("tolerantSource", () => {
  it("reads an erased user's sealed fields as placeholders, where the strict store throws", async () => {
    const { raw, keys, strict } = setup();
    await strict.append(ev(0, "EXECUTION_STARTED", { input: {} }));
    await strict.append(ev(1, "NOTE_ADDED", { text: "secret", kept: "plain" }));
    await strict.append(ev(2, "OTHER_ADDED", { body: "also secret" }));
    const tolerant = tolerantSource({ raw, keys, strict });
    expect((await tolerant.read(EXEC))[1]?.payload).toEqual({ text: "secret", kept: "plain" });

    await userShredder({ keys, raw: { eventStore: raw, snapshotStore: noSnapshots } })(U, [EXEC]);

    await expect(strict.read(EXEC)).rejects.toBeInstanceOf(PayloadShreddedError);
    const events = await tolerant.read(EXEC);
    const payloadOf = (i: number) => events[i]?.payload as Record<string, unknown>;
    expect(isShredded(payloadOf(1).text)).toBe(true);
    expect(payloadOf(1).kept).toBe("plain");
    expect(isShredded(payloadOf(2).body)).toBe(true); // a path registered after construction is covered
    expect(events.at(-1)?.eventType).toBe("PAYLOAD_SHREDDED");
    expect((await tolerant.readFrom(EXEC, 2)).length).toBe(3);
  });

  it("is not a way around a missing key: a node without the key, and no tombstone, still refuses", async () => {
    const { raw, strict } = setup();
    await strict.append(ev(0, "NOTE_ADDED", { text: "secret" }));
    const elsewhere = tolerantSource({ raw, keys: new InMemoryKeyStore(), strict });
    await expect(elsewhere.read(EXEC)).rejects.toSatisfy(isKeyUnavailable);
  });

  it("a key that was never destroyed still refuses, even when the key store can say so", async () => {
    const { raw, strict } = setup();
    await strict.append(ev(0, "NOTE_ADDED", { text: "secret" }));
    const elsewhere = tolerantSource({ raw, keys: new InMemoryKeyStore(), strict });
    await expect(elsewhere.read(EXEC)).rejects.toSatisfy(isKeyUnavailable);
    await expect(elsewhere.readFrom(EXEC, 0)).rejects.toSatisfy(isKeyUnavailable);
  });

  it("a destroyed key with no tombstone yet (a crashed shred) reads as shredded, not as lost", async () => {
    const { raw, keys, strict } = setup();
    await strict.append(ev(0, "EXECUTION_STARTED", { input: {} }));
    await strict.append(ev(1, "NOTE_ADDED", { text: "secret", kept: "plain" }));
    await keys.destroy(subjectOfExecution({ executionId: EXEC }));
    const tolerant = tolerantSource({ raw, keys, strict });
    for (const events of [await tolerant.read(EXEC), await tolerant.readFrom(EXEC, 0)]) {
      expect(events.some((e) => e.eventType === "PAYLOAD_SHREDDED")).toBe(false);
      const payload = events[1]?.payload as Record<string, unknown>;
      expect(isShredded(payload.text)).toBe(true);
      expect(payload.kept).toBe("plain");
    }
  });

  it("is a reader: it lists executions like the strict store", async () => {
    const { raw, keys, strict } = setup();
    await strict.append(ev(0, "EXECUTION_STARTED", { input: {} }));
    const tolerant = tolerantSource({ raw, keys, strict });
    expect(await tolerant.listExecutionsPage?.({ limit: 10 })).toEqual({ executionIds: [EXEC] });
  });
});
