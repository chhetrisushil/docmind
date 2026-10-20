import { createHash } from "node:crypto";
import { ChatToolStep, Locator } from "@docmind/contracts";
import type { RefusalDetails } from "@docmind/llm-anthropic";
import type { Pool } from "pg";
import { z } from "zod";
import type { FieldCrypto } from "../crypto/fields";
import { withTenant } from "../db/tenant";

export interface ChatRef {
  tenantId: string;
  userId: string;
  chatId: string;
}

export interface StoredPassage {
  passageId: string;
  documentId: string;
  locator: Locator;
  headingPath: string[];
  snippet: string;
}

export type TurnItem =
  | { kind: "tool"; body: ChatToolStep }
  | { kind: "passages"; body: { passages: StoredPassage[] } }
  | { kind: "outcome"; body: { kind: "refusal" | "max_tokens"; details?: RefusalDetails } };

/** One schema per kind, applied on the way in and on the way out. Nothing sealed is trusted. */
const BODIES = {
  tool: ChatToolStep.strict(),
  passages: z
    .object({
      passages: z
        .array(
          z
            .object({
              passageId: z.string().uuid(),
              documentId: z.string().uuid(),
              locator: Locator,
              headingPath: z.array(z.string()),
              snippet: z.string(),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
  outcome: z
    .object({
      kind: z.enum(["refusal", "max_tokens"]),
      details: z
        .object({ category: z.string().optional(), explanation: z.string().optional() })
        .strict()
        .optional(),
    })
    .strict(),
} as const;

/** The seal binds (spec 4.4). */
export const chatItemBind = (id: string) => `chatitem:${id}`;

/** Sealed values larger than this (as JSON) are refused: a runaway tool result must not fill the table. */
export const MAX_SEALED_BYTES = 256 * 1024;
export const MAX_STEP_KEY = 200;
/** Turn keys are int4; one call asks for at most this many turns. */
export const MAX_TURN_KEY = 2 ** 31 - 1;
export const MAX_TURN_KEYS = 500;

/**
 * The row id, derived from the natural key (chat, turn key, kind, step key) so a retried attempt rewrites its
 * own row under the same seal bind. A uuid-shaped SHA-256 prefix; it carries no content.
 */
export function chatItemId(
  userId: string,
  chatId: string,
  turnKey: number,
  kind: TurnItem["kind"],
  stepKey: string,
): string {
  const h = createHash("sha256")
    .update(["chatitem", userId, chatId, turnKey, kind, stepKey].join("\0"))
    .digest();
  h[6] = ((h[6] as number) & 0x0f) | 0x50;
  h[8] = ((h[8] as number) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const tooLarge = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8") > MAX_SEALED_BYTES;

/**
 * What the conversation record cannot carry (D5): tool steps, retrieved passages and
 * outcomes of a turn, append-only and sealed under the owner's key. Every statement is owner-scoped
 * (`user_id`) inside `withTenant`; the composite foreign key makes a row of a chat that is not the
 * writer's impossible.
 */
export class PgTurnItems {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  /** Writes the item for (turnKey, kind, stepKey), replacing an earlier attempt's. */
  async put(ref: ChatRef, turnKey: number, stepKey: string, item: TurnItem): Promise<void> {
    if (!Object.hasOwn(BODIES, item.kind)) throw new RangeError("turn item: unknown kind");
    if (!Number.isInteger(turnKey) || turnKey < 0 || turnKey > MAX_TURN_KEY)
      throw new RangeError("turn item: turn key must be a non-negative integer");
    if (stepKey.length < 1 || stepKey.length > MAX_STEP_KEY)
      throw new RangeError("turn item: step key has a bad length");
    const parsed = BODIES[item.kind].safeParse(item.body);
    if (!parsed.success) throw new Error("the turn item has an invalid shape");
    if (tooLarge(parsed.data)) throw new RangeError("turn item: the body is too large");
    const id = chatItemId(ref.userId, ref.chatId, turnKey, item.kind, stepKey);
    const sealed = await this.fields.forUser(ref.userId).seal(chatItemBind(id), parsed.data);
    await withTenant(this.pool, ref.tenantId, (tx) =>
      tx.query(
        `INSERT INTO chat_turn_items (id, tenant_id, user_id, chat_id, ord, kind, step_key, body_enc)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (tenant_id, user_id, chat_id, ord, kind, step_key) DO UPDATE SET body_enc = EXCLUDED.body_enc`,
        [
          id,
          ref.tenantId,
          ref.userId,
          ref.chatId,
          turnKey,
          item.kind,
          stepKey,
          JSON.stringify(sealed),
        ],
      ),
    );
  }

  /** Deletes the item of (turnKey, kind, stepKey), if any: a retried or refused attempt's stale row. Owner-scoped. */
  async remove(
    ref: ChatRef,
    turnKey: number,
    stepKey: string,
    kind: TurnItem["kind"],
  ): Promise<void> {
    if (!Number.isInteger(turnKey) || turnKey < 0 || turnKey > MAX_TURN_KEY)
      throw new RangeError("turn item: turn key must be a non-negative integer");
    if (stepKey.length < 1 || stepKey.length > MAX_STEP_KEY)
      throw new RangeError("turn item: step key has a bad length");
    await withTenant(this.pool, ref.tenantId, (tx) =>
      tx.query(
        `DELETE FROM chat_turn_items
          WHERE chat_id = $1 AND user_id = $2 AND ord = $3 AND kind = $4 AND step_key = $5`,
        [ref.chatId, ref.userId, turnKey, kind, stepKey],
      ),
    );
  }

  /** The items of the listed turn keys, each turn's in the order first written. Turns without items are absent. */
  async forTurns(ref: ChatRef, turnKeys: readonly number[]): Promise<Map<number, TurnItem[]>> {
    const out = new Map<number, TurnItem[]>();
    if (turnKeys.length === 0) return out;
    if (
      turnKeys.length > MAX_TURN_KEYS ||
      !turnKeys.every((k) => Number.isInteger(k) && k >= 0 && k <= MAX_TURN_KEY)
    )
      throw new RangeError("turn item: bad turn keys");
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const res = await tx.query<{
        id: string;
        ord: number;
        kind: TurnItem["kind"];
        body_enc: unknown;
      }>(
        `SELECT id, ord, kind, body_enc FROM chat_turn_items
          WHERE chat_id = $1 AND user_id = $2 AND ord = ANY($3::int[])
          ORDER BY ord, seq`,
        [ref.chatId, ref.userId, [...new Set(turnKeys)]],
      );
      return res.rows;
    });
    const cipher = this.fields.forUser(ref.userId);
    for (const r of rows) {
      const schema = BODIES[r.kind];
      const parsed = schema.safeParse(await cipher.open(chatItemBind(r.id), r.body_enc));
      // A fixed message: the parse error could carry decrypted content.
      if (!parsed.success) throw new Error("the stored turn item has an invalid shape");
      const list = out.get(r.ord) ?? [];
      list.push({ kind: r.kind, body: parsed.data } as TurnItem);
      out.set(r.ord, list);
    }
    return out;
  }
}
