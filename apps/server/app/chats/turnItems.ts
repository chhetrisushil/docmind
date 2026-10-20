import { createHash } from "node:crypto";
import { ChatToolStep, Locator } from "@docmind/contracts";
import type { ReasoningBlock, RefusalDetails } from "@docmind/llm-anthropic";
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
  | { kind: "thinking"; body: { text: string } }
  | { kind: "tool"; body: ChatToolStep }
  | { kind: "passages"; body: { passages: StoredPassage[] } }
  | { kind: "outcome"; body: { kind: "refusal" | "max_tokens"; details?: RefusalDetails } };

/** One schema per kind, applied on the way in and on the way out. Nothing sealed is trusted. */
const BODIES = {
  thinking: z.object({ text: z.string() }).strict(),
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

/**
 * The row id, derived from the natural key (chat, turn key, kind, step key) so a retried attempt rewrites its
 * own row under the same seal bind. A uuid-shaped SHA-256 prefix; it carries no content.
 */
export function chatItemId(
  chatId: string,
  turnKey: number,
  kind: TurnItem["kind"],
  stepKey: string,
): string {
  const h = createHash("sha256")
    .update(["chatitem", chatId, turnKey, kind, stepKey].join("\0"))
    .digest();
  h[6] = ((h[6] as number) & 0x0f) | 0x50;
  h[8] = ((h[8] as number) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const tooLarge = (v: unknown) => JSON.stringify(v).length > MAX_SEALED_BYTES;

/**
 * What the conversation record cannot carry (D5): thinking, tool steps, retrieved passages and
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
    if (!Number.isInteger(turnKey) || turnKey < 0)
      throw new RangeError("turn item: turn key must be a non-negative integer");
    if (stepKey.length < 1 || stepKey.length > MAX_STEP_KEY)
      throw new RangeError("turn item: step key has a bad length");
    const parsed = BODIES[item.kind].safeParse(item.body);
    if (!parsed.success) throw new Error("the turn item has an invalid shape");
    if (tooLarge(parsed.data)) throw new RangeError("turn item: the body is too large");
    const id = chatItemId(ref.chatId, turnKey, item.kind, stepKey);
    const sealed = await this.fields.forUser(ref.userId).seal(chatItemBind(id), parsed.data);
    await withTenant(this.pool, ref.tenantId, (tx) =>
      tx.query(
        `INSERT INTO chat_turn_items (id, tenant_id, user_id, chat_id, ord, kind, step_key, body_enc)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (tenant_id, chat_id, ord, kind, step_key) DO UPDATE SET body_enc = EXCLUDED.body_enc`,
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

  /** The items of the listed turn keys, each turn's in the order first written. Turns without items are absent. */
  async forTurns(ref: ChatRef, turnKeys: readonly number[]): Promise<Map<number, TurnItem[]>> {
    const out = new Map<number, TurnItem[]>();
    if (turnKeys.length === 0) return out;
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

/** A response's content blocks, opaque: any object with a string `type`, kept verbatim. */
const BLOCKS = z.object({
  blocks: z.array(z.object({ type: z.string() }).passthrough()).min(1),
});

export const chatBlocksBind = (chatId: string, toolUseId: string) =>
  `chatblocks:${chatId}:${toolUseId}`;

/** At most this many tool_use ids per call. */
export const MAX_TOOL_USE_IDS = 64;

const validToolUseId = (id: string) => id.length >= 1 && id.length <= MAX_STEP_KEY;

/**
 * A response's full ordered content blocks (D3, ruling P1): the signed thinking blocks together with
 * the text and tool_use blocks they sat between, opaque and echoed verbatim, stored whole and sealed,
 * one row per tool_use id. A response with two tool_use ids stores the same list under both; `get`
 * returns that list once. A response without tool_use ids stores nothing.
 */
export class PgReasoningBlocks {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  async put(
    ref: ChatRef,
    toolUseIds: readonly string[],
    blocks: readonly ReasoningBlock[],
  ): Promise<void> {
    const ids = [...new Set(toolUseIds)];
    if (ids.length === 0 || blocks.length === 0) return;
    if (ids.length > MAX_TOOL_USE_IDS || !ids.every(validToolUseId))
      throw new RangeError("reasoning blocks: bad tool use ids");
    const parsed = BLOCKS.safeParse({ blocks });
    if (!parsed.success) throw new Error("the reasoning blocks have an invalid shape");
    if (tooLarge(parsed.data)) throw new RangeError("reasoning blocks: too large");
    const cipher = this.fields.forUser(ref.userId);
    const sealed = await Promise.all(
      ids.map(async (id) =>
        JSON.stringify(await cipher.seal(chatBlocksBind(ref.chatId, id), parsed.data)),
      ),
    );
    await withTenant(this.pool, ref.tenantId, (tx) =>
      tx.query(
        `INSERT INTO chat_reasoning_blocks (tenant_id, user_id, chat_id, tool_use_id, blocks_enc)
         SELECT $1, $2, $3, u.id, u.enc::jsonb FROM unnest($4::text[], $5::text[]) AS u(id, enc)
         ON CONFLICT (tenant_id, chat_id, tool_use_id) DO UPDATE SET blocks_enc = EXCLUDED.blocks_enc`,
        [ref.tenantId, ref.userId, ref.chatId, ids, sealed],
      ),
    );
  }

  /** The block lists stored for these tool_use ids, in the order of `toolUseIds`, an identical list once. Unknown ids yield none. */
  async get(ref: ChatRef, toolUseIds: readonly string[]): Promise<ReasoningBlock[]> {
    const ids = [...new Set(toolUseIds)].filter(validToolUseId).slice(0, MAX_TOOL_USE_IDS);
    if (ids.length === 0) return [];
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const res = await tx.query<{ tool_use_id: string; blocks_enc: unknown }>(
        `SELECT tool_use_id, blocks_enc FROM chat_reasoning_blocks
          WHERE chat_id = $1 AND user_id = $2 AND tool_use_id = ANY($3::text[])`,
        [ref.chatId, ref.userId, ids],
      );
      return res.rows;
    });
    const byId = new Map(rows.map((r) => [r.tool_use_id, r.blocks_enc]));
    const cipher = this.fields.forUser(ref.userId);
    const seen = new Set<string>(); // one response's list is stored under each of its ids
    const out: ReasoningBlock[] = [];
    for (const id of ids) {
      const enc = byId.get(id);
      if (enc === undefined) continue;
      const parsed = BLOCKS.safeParse(await cipher.open(chatBlocksBind(ref.chatId, id), enc));
      if (!parsed.success) throw new Error("the stored reasoning blocks have an invalid shape");
      const key = JSON.stringify(parsed.data.blocks);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(...parsed.data.blocks);
    }
    return out;
  }
}
