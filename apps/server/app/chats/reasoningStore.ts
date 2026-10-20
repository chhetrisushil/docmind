import { randomBytes } from "node:crypto";
import type { ReasoningReader, ReasoningStore } from "@loom/llm";
import { type FieldCrypto, FieldKeyUnavailableError } from "../crypto/fields";
import { chatIdOfConversation } from "./ids";
import { chatScope } from "./scope";
import type { ChatRef } from "./turnItems";

/** `put` or a model-path `get` outside a chat call, or a text that does not belong to the call's chat. Names nothing. */
export class ReasoningScopeError extends Error {
  constructor() {
    super("no chat scope for this reasoning access");
    this.name = "ReasoningScopeError";
  }
}

/** One captured text (a summary is a few KiB). A larger one is refused: it fails the step, which Loom retries. */
export const MAX_REASONING_BYTES = 512 * 1024;

const ADDRESS = /^[0-9a-f]{32}$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** The seal binds row and column (spec 4.4); the cipher adds the owner. */
export const chatReasoningBind = (chatId: string, address: string) =>
  `chatreasoning:${chatId}:${address}`;

/** Where the sealed envelopes live: Postgres in production (`PgReasoningRows`), a map in tests. Owner-scoped by `ref`. */
export interface ReasoningRows {
  put(ref: ChatRef, address: string, sealed: unknown): Promise<void>;
  get(ref: ChatRef, address: string): Promise<unknown | null>;
}

/** The chat and owner a sealed Loom blob names (`{"e": executionId, "t": text}`), or null. */
function ownerOfEnvelope(text: string): { userId: string; chatId: string } | null {
  try {
    const v = JSON.parse(text) as { e?: unknown; t?: unknown } | null;
    if (v === null || typeof v !== "object" || typeof v.e !== "string" || typeof v.t !== "string")
      return null;
    return chatIdOfConversation(v.e);
  } catch {
    return null;
  }
}

/**
 * Loom's reasoning sidecar store (ADR 0133 D3), sealed under the owning user's key (A3).
 *
 * Loom calls `put(bytes)` with no context. The owner is taken from the `chatScope` ALS, which
 * `chatModelEffect` holds around the whole model call (so also around Loom's request-time resolution of
 * earlier reasoning), and is cross-checked against the execution id inside the bytes. Outside a chat call both
 * methods refuse. A route reads through `readerFor(ref)`, which is fixed to one owner's chat and needs no ALS.
 *
 * The address is random, never a hash: a hash of the sealed envelope (execution id plus text) would let someone
 * holding the table confirm a guessed summary. Erasure: rows cascade with the chat and the user; destroying the
 * owner's key makes `get` answer `null`, which Loom reports as `erased` and treats as a hole in continuation.
 */
export class ChatReasoningStore implements ReasoningStore {
  constructor(
    private readonly rows: ReasoningRows,
    private readonly fields: FieldCrypto,
    private readonly scope: () => ChatRef | undefined = () => chatScope.current(),
  ) {}

  async put(bytes: Uint8Array): Promise<{ readonly __loomContent: string }> {
    const ref = this.requireScope();
    if (bytes.byteLength > MAX_REASONING_BYTES) throw new RangeError("reasoning text is too large");
    let text: string;
    try {
      text = utf8.decode(bytes);
    } catch {
      throw new TypeError("reasoning text is not valid UTF-8");
    }
    const owner = ownerOfEnvelope(text);
    if (owner === null || owner.userId !== ref.userId || owner.chatId !== ref.chatId)
      throw new ReasoningScopeError();
    const address = randomBytes(16).toString("hex");
    const sealed = await this.fields
      .forUser(ref.userId)
      .seal(chatReasoningBind(ref.chatId, address), text);
    await this.rows.put(ref, address, sealed);
    return { __loomContent: address };
  }

  async get(ref: { readonly __loomContent: string }): Promise<Uint8Array | null> {
    return this.read(this.requireScope(), ref.__loomContent);
  }

  /** A reader fixed to one owner's chat, for routes (no ALS). */
  readerFor(ref: ChatRef): ReasoningReader {
    const fixed: ChatRef = { tenantId: ref.tenantId, userId: ref.userId, chatId: ref.chatId };
    return { get: async (r) => this.read(fixed, r.__loomContent) };
  }

  private requireScope(): ChatRef {
    const s = this.scope();
    if (!s) throw new ReasoningScopeError();
    return { tenantId: s.tenantId, userId: s.userId, chatId: s.chatId };
  }

  private async read(ref: ChatRef, address: string): Promise<Uint8Array | null> {
    if (!ADDRESS.test(address)) return null; // a forged or foreign ref is "not yours"
    const sealed = await this.rows.get(ref, address);
    if (sealed === null) return null;
    try {
      const text = await this.fields
        .forUser(ref.userId)
        .openText(chatReasoningBind(ref.chatId, address), sealed);
      return encoder.encode(text);
    } catch (err) {
      if (err instanceof FieldKeyUnavailableError) return null; // the owner's key is gone: erased
      throw err; // a key store outage or a tampered envelope is not "erased"
    }
  }
}
