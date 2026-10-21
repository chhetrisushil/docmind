import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type Hit, type Who, payloadIsIdsOnly, unexpected, unlistedStrings } from "./e2eSupport";

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
          hit("loom.events", "payload", {
            execution_id: "__loom_erasure__",
            event_type: "ERASURE_PENDING",
            payload: { subjectId: who.userId },
          }),
          hit("public.erasure_requests", "user_id", { user_id: who.userId, state: "done" }),
        ],
        who,
      ),
    ).toEqual([]);
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
