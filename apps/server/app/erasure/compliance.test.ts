import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SubjectIndex } from "@loom/compliance";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { describe, expect, it, vi } from "vitest";
import { chatConversationId } from "../chats/ids";
import { loomWarn } from "../config";
import { executionIdFor } from "../subject";
import {
  complianceConfig,
  hydrateSubjectIndex,
  userShredder,
  userSubjectOf,
  warningFor,
} from "./compliance";
import { noSnapshots } from "./testing";

const [A, B] = [randomUUID(), randomUUID()];
const CHAT = randomUUID();

const ev = (
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown = {},
): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "wf",
  executionId,
  eventType,
  sequence,
  timestamp: 1_000 + sequence,
  payload,
});
const subjectOf = (e: EventEnvelope) => userSubjectOf(e);
const index = () => new SubjectIndex(subjectOf);

/** A store that can only list: hydration must not need to read (or decrypt) a single event. */
const listOnly = (
  ids: readonly string[],
  seen: { cursors: (string | undefined)[] } = { cursors: [] },
) => {
  const sorted = [...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return {
    async listExecutionsPage(opts?: { cursor?: string; limit?: number }) {
      const cursor = opts?.cursor;
      seen.cursors.push(cursor);
      const after = cursor === undefined ? sorted : sorted.filter((id) => id > cursor);
      const limit = opts?.limit ?? 1000;
      const executionIds = after.slice(0, limit);
      return {
        executionIds,
        ...(after.length > limit && {
          nextCursor: executionIds[executionIds.length - 1] as string,
        }),
      };
    },
  };
};

describe("userSubjectOf", () => {
  it("is the user for every execution the user owns", () => {
    for (const executionId of [
      executionIdFor(A, "ingest-x"),
      executionIdFor(A, "chat-title-y"),
      chatConversationId(A, CHAT),
      `${chatConversationId(A, CHAT)}~3`,
      `${executionIdFor(A, "ingest-x")}::step#0`,
    ])
      expect(userSubjectOf({ executionId })).toBe(A);
  });

  it("is undefined for an execution no user owns, so the index never groups it", () => {
    for (const executionId of ["system-sweep", "u_not-a-uuid:a", `x_${A}:a`, A, "__loom_erasure__"])
      expect(userSubjectOf({ executionId })).toBeUndefined();
  });
});

describe("hydrateSubjectIndex", () => {
  const ids = [
    executionIdFor(A, "ingest-1"),
    executionIdFor(A, "ingest-1.2"),
    executionIdFor(A, "chat-title-1"),
    chatConversationId(A, CHAT),
    `${chatConversationId(A, CHAT)}~1`,
    executionIdFor(B, "ingest-1"),
    "system-sweep",
    "__loom_erasure__",
    "zz-after-the-user-range",
  ];

  it("attributes every user-owned execution to its user and nothing else", async () => {
    const idx = index();
    expect(await hydrateSubjectIndex(listOnly(ids), idx)).toBe(6);
    expect(idx.executionsOf(A)).toEqual(ids.slice(0, 5).sort());
    expect(idx.executionsOf(B)).toEqual([executionIdFor(B, "ingest-1")]);
    expect(idx.subjects()).toEqual([A, B].sort());
  });

  it("pages: a page size of 2 finds the same executions", async () => {
    const idx = index();
    expect(await hydrateSubjectIndex(listOnly(ids), idx, 2)).toBe(6);
    expect(idx.executionsOf(A)).toHaveLength(5);
  });

  it("seeks to the user range and stops at its end, never walking the rest of the log", async () => {
    const tail = Array.from({ length: 50 }, (_, i) => `zz-${String(i).padStart(3, "0")}`);
    const head = Array.from({ length: 50 }, (_, i) => `aa-${String(i).padStart(3, "0")}`);
    const seen = { cursors: [] as (string | undefined)[] };
    const idx = index();
    expect(await hydrateSubjectIndex(listOnly([...head, ...ids, ...tail], seen), idx, 4)).toBe(6);
    expect(seen.cursors[0]).toBe("u_"); // no scan from the start of the log
    // 6 user ids at 4 per page: the second page reaches the first non-user id and ends the walk.
    expect(seen.cursors).toHaveLength(2);
  });

  it("is idempotent, and merges with what the live feed already indexed", async () => {
    const idx = index();
    idx.handleEvent(ev(executionIdFor(A, "ingest-1"), 0, "EXECUTION_STARTED"));
    await hydrateSubjectIndex(listOnly(ids), idx);
    await hydrateSubjectIndex(listOnly(ids), idx);
    expect(idx.executionsOf(A)).toHaveLength(5);
  });

  it("is a no-op for a store with no user executions", async () => {
    const idx = index();
    expect(await hydrateSubjectIndex(listOnly(["system-sweep"]), idx)).toBe(0);
    expect(idx.size).toBe(0);
  });

  it("refuses a store that cannot list executions: erasure would silently find nothing", async () => {
    await expect(hydrateSubjectIndex({}, index())).rejects.toThrow(/cannot list executions/);
  });
});

describe("userShredder", () => {
  it("destroys the user's key and tombstones every named execution on the raw log", async () => {
    const keys = new InMemoryKeyStore();
    const raw = new InMemoryAsyncEventStore();
    const [e1, e2] = [executionIdFor(A, "ingest-1"), chatConversationId(A, CHAT)];
    for (const id of [e1, e2]) {
      await raw.append(ev(id, 0, "EXECUTION_STARTED"));
      await raw.append(ev(id, 1, "EXECUTION_COMPLETED"));
    }
    await keys.getOrCreate(A);
    const shred = userShredder({ keys, raw: { eventStore: raw, snapshotStore: noSnapshots } });

    await shred(A, [e1, e2]);
    expect(await keys.wasDestroyed(A)).toBe(true);
    for (const id of [e1, e2])
      expect((await raw.read(id)).map((e) => e.eventType)).toEqual([
        "EXECUTION_STARTED",
        "EXECUTION_COMPLETED",
        "ERASURE_PENDING",
        "PAYLOAD_SHREDDED",
      ]);

    await shred(A, [e1, e2]); // idempotent: Loom calls it again on a retry
    expect((await raw.read(e1)).filter((e) => e.eventType === "PAYLOAD_SHREDDED")).toHaveLength(1);
  });

  it("does nothing for an empty execution list", async () => {
    const keys = new InMemoryKeyStore();
    const shred = userShredder({
      keys,
      raw: { eventStore: new InMemoryAsyncEventStore(), snapshotStore: noSnapshots },
    });
    await shred(A, []);
    expect(await keys.wasDestroyed(A)).toBe(false);
  });
});

describe("complianceConfig", () => {
  it("names the resolver and the shredder, and takes the destruction proof from the key store", async () => {
    const keys = new InMemoryKeyStore();
    const cfg = complianceConfig({
      keys,
      raw: { eventStore: new InMemoryAsyncEventStore(), snapshotStore: noSnapshots },
    });
    expect(cfg.subjectOf).toBe(userSubjectOf);
    expect(typeof cfg.erase.shred).toBe("function");
    expect(await cfg.erase.destroyed?.(A)).toBe(false);
    await keys.destroy(A);
    expect(await cfg.erase.destroyed?.(A)).toBe(true);
  });
});

describe("warningFor", () => {
  it("redacts the execution id of Loom's sealed-stream refusal and keeps the diagnosis", () => {
    const id = executionIdFor(A, "chat-1");
    const msg = `execution "${id}": REFUSED, this node cannot open the stream (key-unavailable at sequence 3, sealed: payload). Nothing was appended.`;
    expect(warningFor(msg)).toBe(
      'execution "<id>": REFUSED, this node cannot open the stream (key-unavailable at sequence 3, sealed: payload). Nothing was appended.',
    );
  });

  it("redacts ids in an erasure coordinator notice and keeps the error class", () => {
    const msg = `erasure coordinator: ShredIncompleteError: shredSubject("${A}"): failed (${executionIdFor(A, "ingest-1")}, ${chatConversationId(A, CHAT)}) — the request stays parked`;
    expect(warningFor(msg)).toBe(
      'erasure coordinator: ShredIncompleteError: shredSubject("<id>"): failed (<id>, <id>) — the request stays parked',
    );
  });

  it("redacts a quoted execution id of any shape, a bare uuid and an inbox stream id", () => {
    expect(warningFor('execution "title-abc": REFUSED')).toBe('execution "<id>": REFUSED');
    expect(warningFor(`user ${A.toUpperCase()} unknown`)).toBe("user <id> unknown");
    expect(warningFor(`stream __loom_inbox__:${chatConversationId(A, CHAT)} stuck`)).toBe(
      "stream __loom_inbox__:<id> stuck",
    );
  });

  it("redacts an email-shaped string too", () => {
    expect(warningFor("login failed for Ada.Lovelace+x@Example.co.uk twice")).toBe(
      "login failed for <email> twice",
    );
  });

  it("keeps an id-free boot notice as it is", () => {
    expect(warningFor("verify: 3 checks passed")).toBe("verify: 3 checks passed");
  });
});

describe("the onWarn sink of buildApp", () => {
  it("prints redacted text", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      loomWarn(`execution "${executionIdFor(A, "chat-1")}": REFUSED`);
      expect(warn).toHaveBeenCalledWith("[loom]", 'execution "<id>": REFUSED');
    } finally {
      warn.mockRestore();
    }
  });

  it("is installed in the config whether or not erasure is wired (not under the erasure spread)", () => {
    const src = readFileSync(join(__dirname, "../config.ts"), "utf8");
    const block = /observability: \{([\s\S]*?)\n {4}\},/.exec(src)?.[1] ?? "";
    expect(block).toContain("onWarn: loomWarn,");
    expect(block).not.toContain("erasure");
  });
});
