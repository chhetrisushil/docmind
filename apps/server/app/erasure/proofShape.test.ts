import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type Hit,
  type Who,
  eventColumnProblems,
  payloadIsIdsOnly,
  unexpected,
  unlistedStrings,
} from "./e2eSupport";

const who: Who = {
  userId: randomUUID(),
  tenantId: randomUUID(),
  email: "ada@example.com",
  sentinels: ["sentinel-doc-0123456789ab"],
};
const hit = (table: string, column: string, ...rows: Record<string, unknown>[]): Hit => ({
  table,
  column,
  rows,
});
const own = `u_${who.userId}:ingest-x.2`;
const envelope = { __loomEnc: "loom/aes-256-gcm", data: "x" };

describe("the proof's allowlist of residue", () => {
  it("accepts only the residue D7 allows, in its exact shape", () => {
    expect(
      unexpected(
        [
          hit("public.data_keys", "subject_id", {
            subject_id: who.userId,
            wrapped_dek: null,
            destroyed_at: "t",
          }),
          hit("public.read_model_state", "scope", { scope: who.userId, state: null, erased: true }),
          hit("loom.events", "execution_id", { execution_id: own, event_type: "STEP_STARTED" }),
          hit("loom.events", "payload", {
            execution_id: own,
            payload: { input: { userId: who.userId } },
          }),
          hit("loom.fences", "execution_id", { execution_id: own }),
          hit("loom.snapshots", "execution_id", { execution_id: own, state: envelope }),
          hit("public.erasure_requests", "user_id", { user_id: who.userId, state: "done" }),
        ],
        who,
      ),
    ).toEqual([]);
  });

  it("rejects a plaintext subject id on Loom's erasure control stream (the control-stream key keeps it off)", () => {
    expect(
      unexpected(
        [
          hit("loom.events", "payload", {
            execution_id: "__loom_erasure__",
            event_type: "ERASURE_PENDING",
            payload: { subjectId: who.userId },
          }),
        ],
        who,
      ),
    ).toEqual(["loom.events.payload"]);
  });

  it("rejects a live read-model row, a key that still has material, and a plaintext checkpoint", () => {
    const bad = unexpected(
      [
        hit("public.read_model_state", "scope", {
          scope: who.tenantId,
          state: { note: "x" },
          erased: false,
        }),
        hit("public.data_keys", "subject_id", {
          subject_id: who.userId,
          wrapped_dek: "k",
          destroyed_at: null,
        }),
        hit("loom.snapshots", "execution_id", { execution_id: own, state: { plain: true } }),
      ],
      who,
    );
    expect(bad).toEqual([
      "public.read_model_state.scope",
      "public.data_keys.subject_id",
      "loom.snapshots.execution_id",
    ]);
  });

  it("rejects content in an allowed column, another user's execution, and a table or column not listed", () => {
    const bad = unexpected(
      [
        hit("loom.events", "payload", { execution_id: own, payload: { text: who.sentinels[0] } }),
        hit("loom.events", "execution_id", { execution_id: `u_${randomUUID()}:x` }),
        hit("public.documents", "owner_id", { owner_id: who.userId }),
        hit("loom.memory_entries", "content", { content: "x" }),
      ],
      who,
    );
    expect(bad).toEqual([
      "loom.events.payload",
      "loom.events.execution_id",
      "public.documents.owner_id",
      "loom.memory_entries.content",
    ]);
  });

  it("accepts a payload only if it is an envelope or all its string leaves are listed ids or tokens", () => {
    const input = { userId: who.userId, tenantId: who.tenantId, documentId: randomUUID() };
    expect(payloadIsIdsOnly({ input, flowHash: "fnv1a:f2dbe2c7", sealed: envelope })).toBe(true);
    expect(
      payloadIsIdsOnly({ topic: "conversation:turn", sender: { actor: who.userId }, waitId: "#0" }),
    ).toBe(true);
    // content under a listed key, or under an unlisted one
    expect(payloadIsIdsOnly({ input: { ...input, entityName: "Acme Holdings" } })).toBe(false);
    expect(payloadIsIdsOnly({ input: { ...input, documentId: "Acme Holdings" } })).toBe(false);
    expect(payloadIsIdsOnly({ stepId: "ingest-parse", output: { title: "Q3 report" } })).toBe(
      false,
    );
    expect(payloadIsIdsOnly(["a plain string"])).toBe(false);
    // a new-format subject is accepted only for the erased user's own handle
    const own = "h_abcdefghijklmnopqrstuvwxya";
    const handle = own.slice(2);
    const other = "h_bcdefghijklmnopqrstuvwxyza";
    expect(payloadIsIdsOnly({ input: { userId: `${own}:flow` } }, "", handle)).toBe(true);
    expect(payloadIsIdsOnly({ input: { userId: own } }, "", handle)).toBe(true);
    expect(payloadIsIdsOnly({ input: { userId: `${other}:flow` } }, "", handle)).toBe(false);
    expect(payloadIsIdsOnly({ input: { userId: own } })).toBe(false); // no handle given: none accepted
    expect(unlistedStrings({ input: { userId: other } }, "", handle)).toEqual(["userId"]);
    const bad = unexpected(
      [
        hit("loom.events", "payload", {
          execution_id: own,
          payload: { input: { ...input, entityName: "Acme Holdings" } },
        }),
      ],
      who,
    );
    expect(bad).toEqual(["loom.events.payload"]);
  });

  it("on an h_<handle> row, no id key may hold a plaintext UUID: only a sealed value or the user's own handle", () => {
    const handle = "abcdefghijklmnopqrstuvwxya";
    const hWho: Who = { ...who, handle };
    const hId = `h_${handle}:ingest-${"a".repeat(51)}q.2`;
    const row = (payload: unknown) => hit("loom.events", "payload", { execution_id: hId, payload });
    // the leak the denied cancel made: the actor's UUID in the clear on an h_ stream
    expect(unexpected([row({ op: "cancel", reason: "x", actor: who.userId })], hWho)).toEqual([
      "loom.events.payload",
    ]);
    expect(unexpected([row({ input: { userId: who.userId } })], hWho)).toEqual([
      "loom.events.payload",
    ]);
    expect(unexpected([row({ input: { documentId: randomUUID() } })], hWho)).toEqual([
      "loom.events.payload",
    ]);
    expect(unlistedStrings({ actor: who.userId }, "", handle, true)).toEqual(["actor"]);
    // sealed values and the own handle are fine, and a u_ row keeps today's rule
    expect(unexpected([row({ input: { userId: envelope, tenantId: envelope } })], hWho)).toEqual(
      [],
    );
    expect(unexpected([row({ actor: `h_${handle}` })], hWho)).toEqual([]);
    expect(
      unexpected(
        [hit("loom.events", "payload", { execution_id: own, payload: { actor: who.userId } })],
        hWho,
      ),
    ).toEqual([]);
  });

  it("on an h_<handle> row, a UUID-shaped value is refused under ANY key, not only the id keys", () => {
    const handle = "abcdefghijklmnopqrstuvwxya";
    const hWho: Who = { ...who, handle };
    const hId = `h_${handle}:ingest-${"a".repeat(51)}q.2`;
    const row = (payload: unknown) => hit("loom.events", "payload", { execution_id: hId, payload });
    const doc = randomUUID();
    expect(unlistedStrings({ messageId: doc }, "", handle, true)).toEqual(["messageId"]);
    expect(unexpected([row({ messageId: doc })], hWho)).toEqual(["loom.events.payload"]);
    expect(payloadIsIdsOnly({ messageId: doc }, "", handle, true)).toBe(false);
    // the same value on a u_ row keeps the old rule, and a 32 to 64 hex message id is still fine on an h_ row
    expect(unlistedStrings({ messageId: doc }, "", handle, false)).toEqual([]);
    expect(unexpected([row({ messageId: "a".repeat(32) })], hWho)).toEqual([]);
  });

  it("the old-format turn-visuals lineage line accepts only an ids-only payload", () => {
    const line = `__loom_ui_lineage__:turnvisuals-${who.userId}-${randomUUID()}-1`;
    const row = (payload: unknown) =>
      hit("loom.events", "payload", { execution_id: line, event_type: "X", payload });
    expect(unexpected([row({ by: envelope })], who)).toEqual([]);
    expect(unexpected([row({ by: envelope, documentId: randomUUID() })], who)).toEqual([
      "loom.events.payload",
    ]);
    expect(unexpected([row({ by: envelope, note: "plain text" })], who)).toEqual([
      "loom.events.payload",
    ]);
  });

  it("a neutral refolded row is allowed only when its execution id holds no UUID", () => {
    const handle = "abcdefghijklmnopqrstuvwxya";
    const hWho: Who = { ...who, handle };
    const neutral = (execution_id: string) =>
      hit("public.read_model_state", "execution_id", {
        execution_id,
        scope: null,
        app_key: null,
        erased: false,
        state: {},
      });
    expect(unexpected([neutral(`h_${handle}:ingest-${"a".repeat(51)}q.2`)], hWho)).toEqual([]);
    expect(unexpected([neutral(`h_${handle}:ingest-${who.userId}.2`)], hWho)).toEqual([
      "public.read_model_state.execution_id",
    ]);
  });

  it("judges every string of a payload, with or without an id or sentinel beside it", () => {
    expect(payloadIsIdsOnly({ reason: "erased" })).toBe(true);
    expect(payloadIsIdsOnly({ reason: "Acme Holdings invoice" })).toBe(false);
    expect(payloadIsIdsOnly({ note: "Acme Holdings invoice" })).toBe(false);
    expect(unlistedStrings({ output: { count: 1, note: "Acme" }, stepId: "ingest-parse" })).toEqual(
      ["note"],
    );
    expect(unlistedStrings({ a: envelope, b: { __loomEnc: "x" } })).toEqual(["__loomEnc"]);
  });
});

describe("the shape of a raw event's plaintext columns", () => {
  const event = {
    id: `${own}-3`,
    workflowId: "ingest-document",
    executionId: own,
    eventType: "STEP_STARTED",
    sequence: 3,
    timestamp: 1_760_000_000_000,
    payload: {},
  };

  it("accepts ids, fixed tokens, numbers and Loom's operational metadata", () => {
    expect(eventColumnProblems(event)).toEqual([]);
    expect(eventColumnProblems({ ...event, metadata: { kernel: true } })).toEqual([]);
    expect(eventColumnProblems({ ...event, metadata: { fence: 4, kernel: true } })).toEqual([]);
    expect(eventColumnProblems({ ...event, metadata: { computeTarget: "worker-1" } })).toEqual([]);
    expect(eventColumnProblems({ ...event, metadata: null })).toEqual([]);
    const seal = {
      v: 1,
      cipher: "loom/aes-256-gcm",
      covers: ["EXECUTION_STARTED.input.documentId", "STEP_COMPLETED.result.items[].id"],
    };
    expect(eventColumnProblems({ ...event, metadata: { seal } })).toEqual([]);
    expect(
      eventColumnProblems({ ...event, workflowId: "", eventType: "PAYLOAD_SHREDDED" }),
    ).toEqual([]);
    expect(
      eventColumnProblems({
        ...event,
        workflowId: "__loom_erasure__",
        executionId: "__loom_erasure__",
        id: "erasure-0",
        timestamp: 0,
      }),
    ).toEqual([]);
  });

  it("names the column that holds anything else, and never the value", () => {
    const content = "Acme Holdings invoice";
    expect(eventColumnProblems({ ...event, workflowId: content })).toEqual(["workflowId"]);
    expect(eventColumnProblems({ ...event, id: content })).toEqual(["id"]);
    expect(eventColumnProblems({ ...event, executionId: content })).toEqual(["executionId"]);
    expect(eventColumnProblems({ ...event, eventType: "step started" })).toEqual(["eventType"]);
    expect(eventColumnProblems({ ...event, sequence: -1 })).toEqual(["sequence"]);
    expect(eventColumnProblems({ ...event, timestamp: "yesterday" })).toEqual(["timestamp"]);
    expect(eventColumnProblems({ ...event, metadata: { note: content } })).toEqual([
      "metadata.note",
    ]);
    expect(eventColumnProblems({ ...event, metadata: { fence: content } })).toEqual([
      "metadata.fence",
    ]);
    expect(eventColumnProblems({ ...event, metadata: { kernel: false } })).toEqual([
      "metadata.kernel",
    ]);
    expect(eventColumnProblems({ ...event, metadata: [content] })).toEqual(["metadata"]);
    expect(
      eventColumnProblems({
        ...event,
        metadata: { seal: { v: 1, cipher: "loom/aes-256-gcm", covers: [content] } },
      }),
    ).toEqual(["metadata.seal"]);
    expect(
      eventColumnProblems({ ...event, metadata: { seal: { v: 1, cipher: content, covers: [] } } }),
    ).toEqual(["metadata.seal"]);
    expect(
      eventColumnProblems({
        ...event,
        metadata: { seal: { v: 1, cipher: "loom/aes-256-gcm", covers: [], note: content } },
      }),
    ).toEqual(["metadata.seal"]);
    expect(eventColumnProblems({ ...event, workflowId: "" })).toEqual(["workflowId"]);
    expect(eventColumnProblems({ ...event, workflowId: "", eventType: "ERASURE_PENDING" })).toEqual(
      [],
    );
    const metadata = JSON.parse('{"__proto__": true}');
    expect(eventColumnProblems({ ...event, metadata })).toEqual(["metadata.__proto__"]);
    const cipher = "loom/aes-256-gcm";
    const seals: unknown[] = [
      { v: 2, cipher, covers: [] },
      { v: 1, cipher },
      { v: 1, cipher, covers: "EXECUTION_STARTED.input" },
      { v: 1, cipher, covers: ["EXECUTION_STARTED.input documentId"] },
      { v: 1, cipher, covers: Array.from({ length: 257 }, () => "EXECUTION_STARTED.input") },
    ];
    for (const seal of seals)
      expect(eventColumnProblems({ ...event, metadata: { seal } })).toEqual(["metadata.seal"]);
    expect(
      eventColumnProblems({
        ...event,
        metadata: {
          seal: {
            v: 1,
            cipher,
            covers: Array.from({ length: 256 }, () => "EXECUTION_STARTED.input"),
          },
        },
      }),
    ).toEqual([]);
    expect(
      JSON.stringify(eventColumnProblems({ ...event, metadata: { note: content } })),
    ).not.toContain(content);
  });
});
