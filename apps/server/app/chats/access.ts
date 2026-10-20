import type { Identity } from "@docmind/auth";
import { type ChatScope, Uuid } from "@docmind/contracts";
import type { PrincipalChain } from "@loom/effect-runtime";
import type { PoolClient } from "pg";
import { withTenant } from "../db/tenant";
import { type RouteContext, sendError } from "../http/respond";
import type { ChatRouteDeps } from "./routes";
import { type ChatSessionRow, getChat } from "./sessions";

/** What every Loom call of a chat route runs as: the session's own tenant and user, nothing from the request. */
export const principalOf = (identity: Identity): PrincipalChain => ({
  tenant: identity.tenantId,
  actor: identity.userId,
});

/** The `:id` param as a lower-cased UUID, or null (answered like a missing chat). */
export function chatIdParam(ctx: RouteContext): string | null {
  const parsed = Uuid.safeParse(ctx.params.id);
  return parsed.success ? parsed.data.toLowerCase() : null;
}

export const notFound = (res: Parameters<typeof sendError>[0]) =>
  sendError(res, 404, "not_found", "chat not found");

export const unavailable = (res: Parameters<typeof sendError>[0]) =>
  sendError(res, 503, "chat_unavailable", "Chat needs a Claude API key on the server.");

/**
 * The caller's live chat for the `:id` param, or null for anything else (malformed, unknown, foreign,
 * another tenant, deleted).
 */
export async function loadChat(
  deps: Pick<ChatRouteDeps, "pool">,
  identity: Identity,
  ctx: RouteContext,
): Promise<ChatSessionRow | null> {
  const id = chatIdParam(ctx);
  if (id === null) return null;
  return withTenant(deps.pool, identity.tenantId, (tx) => getChat(tx, identity.userId, id));
}

/** Lower-cased and deduplicated ids, so the stored scope and the check agree. */
export function normalizeScope(scope: ChatScope): ChatScope {
  return scope === "all"
    ? "all"
    : { documentIds: [...new Set(scope.documentIds.map((id) => id.toLowerCase()))] };
}

/** True when every document of the scope is the user's own (a foreign id and a missing one are alike). */
export async function scopeIsOwned(
  tx: PoolClient,
  userId: string,
  scope: ChatScope,
): Promise<boolean> {
  if (scope === "all") return true;
  const { rows } = await tx.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM documents WHERE owner_id = $1 AND id = ANY($2::uuid[])",
    [userId, scope.documentIds],
  );
  return Number(rows[0]?.n ?? 0) === scope.documentIds.length;
}
