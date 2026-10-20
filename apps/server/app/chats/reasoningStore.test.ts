import { unwrapTainted } from "@loom/classify";
import {
  LLM_REASONING_CAPTURED,
  captureReasoning,
  readReasoningBounded,
  reasoningStoreResolver,
  sealReasoningText,
} from "@loom/llm";
import { InMemoryKeyStore, type KeyStore } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { chatConversationId } from "./ids";
import {
  ChatReasoningStore,
  MAX_REASONING_BYTES,
  ReasoningScopeError,
  chatReasoningBind,
} from "./reasoningStore";
import { type ChatCallScope, chatScope } from "./scope";
import { C, MemoryReasoningRows, T, U, modelCtx } from "./testing";

const C2 = "c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4";
const U2 = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
const EXEC = chatConversationId(U, C);
const SCOPE: ChatCallScope = {
  tenantId: T,
  userId: U,
  chatId: C,
  turnKey: 3,
  stepKey: "conv#o3#turn:1",
  attempt: 1,
};
const REF = { tenantId: T, userId: U, chatId: C };
const TEXT = "Weighing the Nocturne revenue forecast against the memo.";

function setup() {
  const keys = new InMemoryKeyStore();
  const asked = new Set<string>();
  const recording: KeyStore = {
    getOrCreate: (id) => {
      asked.add(id);
      return keys.getOrCreate(id);
    },
    get: (id) => {
      asked.add(id);
      return keys.get(id);
    },
    destroy: (id) => keys.destroy(id),
  };
  const rows = new MemoryReasoningRows();
  const store = new ChatReasoningStore(rows, new FieldCrypto(recording));
  const inScope = <T2>(fn: () => Promise<T2>, scope: ChatCallScope = SCOPE) =>
    chatScope.run(scope, fn);
  return { keys, asked, rows, store, inScope };
}

describe("ChatReasoningStore", () => {
  it("seals the text under the owner's key, returns a random address, and gives the same bytes back", async () => {
    const s = setup();
    const bytes = sealReasoningText(TEXT, EXEC);
    const ref = await s.inScope(() => s.store.put(bytes));
    expect(ref.__loomContent).toMatch(/^[0-9a-f]{32}$/);
    const [row] = [...s.rows.rows.values()];
    expect((row?.sealed as { __loomEnc?: string }).__loomEnc).toBe("loom/aes-256-gcm");
    expect(JSON.stringify(row)).not.toContain("Nocturne"); // TEXT is longer than 12 characters
    expect(JSON.stringify(row)).not.toContain(EXEC);
    expect([...s.asked]).toEqual([U]);
    expect(await s.inScope(() => s.store.get(ref))).toEqual(bytes);
    expect(await s.store.readerFor(REF).get(ref)).toEqual(bytes); // a route needs no ALS
  });

  it("is not content-addressed: the same bytes stored twice get two addresses", async () => {
    const s = setup();
    const bytes = sealReasoningText(TEXT, EXEC);
    const a = await s.inScope(() => s.store.put(bytes));
    const b = await s.inScope(() => s.store.put(bytes));
    expect(a.__loomContent).not.toBe(b.__loomContent);
    expect(s.rows.rows.size).toBe(2);
  });

  it("refuses put and get outside a chat scope, with a fixed message", async () => {
    const s = setup();
    const bytes = sealReasoningText(TEXT, EXEC);
    await expect(s.store.put(bytes)).rejects.toBeInstanceOf(ReasoningScopeError);
    await expect(s.store.put(bytes)).rejects.toThrow(/^no chat scope for this reasoning access$/);
    await expect(s.store.get({ __loomContent: "a".repeat(32) })).rejects.toBeInstanceOf(
      ReasoningScopeError,
    );
    expect(s.rows.rows.size).toBe(0);
  });

  it("refuses bytes that are not the sealed envelope of THIS chat's execution", async () => {
    const s = setup();
    const enc = new TextEncoder();
    for (const bytes of [
      sealReasoningText(TEXT, chatConversationId(U, C2)), // another chat of the same owner
      sealReasoningText(TEXT, chatConversationId(U2, C)), // another owner
      sealReasoningText(TEXT, "u_a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1:ingest-x.1"), // not a conversation
      enc.encode("plain text, not an envelope"),
      enc.encode(JSON.stringify({ e: EXEC })),
    ]) {
      await expect(s.inScope(() => s.store.put(bytes))).rejects.toBeInstanceOf(ReasoningScopeError);
    }
    expect(s.rows.rows.size).toBe(0);
  });

  it("accepts a later generation of its own conversation", async () => {
    const s = setup();
    const ref = await s.inScope(() => s.store.put(sealReasoningText(TEXT, `${EXEC}~2`)));
    expect(ref.__loomContent).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses a text over the cap and bytes that are not UTF-8", async () => {
    const s = setup();
    await expect(
      s.inScope(() => s.store.put(sealReasoningText("x".repeat(MAX_REASONING_BYTES), EXEC))),
    ).rejects.toThrow(/^reasoning text is too large$/);
    await expect(s.inScope(() => s.store.put(Uint8Array.of(0xff, 0xfe)))).rejects.toThrow(
      /^reasoning text is not valid UTF-8$/,
    );
  });

  it("reads null for an address that is malformed, unknown, or another chat's", async () => {
    const s = setup();
    const ref = await s.inScope(() => s.store.put(sealReasoningText(TEXT, EXEC)));
    expect(await s.inScope(() => s.store.get({ __loomContent: "../../etc/passwd" }))).toBeNull();
    expect(await s.inScope(() => s.store.get({ __loomContent: "0".repeat(32) }))).toBeNull();
    expect(await s.store.readerFor({ ...REF, chatId: C2 }).get(ref)).toBeNull();
    expect(await s.store.readerFor({ ...REF, userId: U2 }).get(ref)).toBeNull();
  });

  it("ties the ciphertext to its row: a sealed copy under another address or chat does not open", async () => {
    const s = setup();
    const ref = await s.inScope(() => s.store.put(sealReasoningText(TEXT, EXEC)));
    const [row] = [...s.rows.rows.values()];
    const other = "b".repeat(32);
    await s.rows.put(REF, other, row?.sealed);
    await s.rows.put({ ...REF, chatId: C2 }, ref.__loomContent, row?.sealed);
    await expect(s.store.readerFor(REF).get({ __loomContent: other })).rejects.toThrow();
    await expect(
      s.store.readerFor({ ...REF, chatId: C2 }).get({ __loomContent: ref.__loomContent }),
    ).rejects.toThrow();
  });

  it("keeps a byte-order mark: it is refused as a non-envelope, and a stored one reads back byte for byte", async () => {
    const s = setup();
    const enc = new TextEncoder();
    const envelope = new TextDecoder().decode(sealReasoningText(TEXT, EXEC));
    const bom = enc.encode(`\uFEFF${envelope}`);
    await expect(s.inScope(() => s.store.put(bom))).rejects.toBeInstanceOf(ReasoningScopeError);
    const address = "d".repeat(32);
    await s.rows.put(
      REF,
      address,
      await new FieldCrypto(s.keys)
        .forUser(U)
        .seal(chatReasoningBind(C, address), `\uFEFF${envelope}`),
    );
    expect(await s.store.readerFor(REF).get({ __loomContent: address })).toEqual(bom);
  });

  it("reads null once the owner's key is destroyed (erased), and rethrows any other failure", async () => {
    const s = setup();
    const ref = await s.inScope(() => s.store.put(sealReasoningText(TEXT, EXEC)));
    await s.keys.destroy(U);
    expect(await s.inScope(() => s.store.get(ref))).toBeNull();

    const boom = new RangeError("the table is down");
    const failing = new ChatReasoningStore(
      { put: async () => {}, get: async () => Promise.reject(boom) },
      new FieldCrypto(new InMemoryKeyStore()),
    );
    await expect(failing.readerFor(REF).get({ __loomContent: "a".repeat(32) })).rejects.toBe(boom);
  });
});

describe("ChatReasoningStore with Loom's capture, resolver and audit reader", () => {
  it("captures a summary, resolves it for continuation inside the call's scope, and reads it back as the owner", async () => {
    const s = setup();
    const log: { eventType: string; payload: unknown }[] = [];
    const ctx = modelCtx({ emit: (eventType, payload) => log.push({ eventType, payload }) });
    const parts = await s.inScope(() =>
      captureReasoning(
        [{ kind: "summary", text: TEXT, signature: "SIG-0123456789", provider: "anthropic" }],
        { store: s.store, model: "claude-opus-5-5" },
        ctx,
      ),
    );
    const part = parts[0];
    if (!part?.textRef) throw new Error("expected a stored text");
    expect(part.signature).toBe("SIG-0123456789");
    expect(log.map((e) => e.eventType)).toEqual([LLM_REASONING_CAPTURED]);
    expect(JSON.stringify(log)).not.toContain("Nocturne"); // the event names references, never text

    // continuation: Loom's default resolver, called while the call's scope is active
    const resolved = await s.inScope(() =>
      reasoningStoreResolver(s.store)(part.textRef as { address: string }, {
        executionId: ctx.executionId,
        stepId: ctx.stepId,
        origin: "reasoning",
        maxBytes: 1024 * 1024,
      }),
    );
    expect(new TextDecoder().decode(resolved ?? new Uint8Array())).toBe(TEXT);
    // a resolver call from another execution is "not yours"
    const foreign = await s.inScope(() =>
      reasoningStoreResolver(s.store)(part.textRef as { address: string }, {
        executionId: chatConversationId(U, C2),
        origin: "reasoning",
        maxBytes: 1024 * 1024,
      }),
    );
    expect(foreign).toBeNull();

    // the audit read (a route's): no ALS, a reader fixed to the owner's chat
    log.push({ eventType: "STEP_COMPLETED", payload: { stepId: ctx.stepId } });
    const read = await readReasoningBounded({ read: async () => log }, s.store.readerFor(REF), {
      executionId: ctx.executionId,
      stepPrefix: "conv#o3#",
    });
    const only = read.steps[0]?.attempts[0]?.parts[0];
    expect(only?.status).toBe("ok");
    expect(only?.text === undefined ? undefined : unwrapTainted(only.text)).toBe(TEXT);
    expect(read.steps[0]?.recordedAttempt).toBe(1);
  });
});
