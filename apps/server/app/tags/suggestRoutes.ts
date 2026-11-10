import type { Authenticator } from "@docmind/auth";
import {
  type DocumentTagsResponse,
  type SuggestTagsResponse,
  TagNameRequest,
} from "@docmind/contracts";
import type { Pool } from "pg";
import { withTenant } from "../db/tenant";
import { getDocument } from "../documents/repo";
import type { SuggestTagsStarter } from "../flows/suggest-tags/start";
import { readJson } from "../http/body";
import type { AuthedHandler } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";
import { authed, idOf, notFound } from "./routes";
import type { TagService } from "./service";

export interface SuggestRoutesDeps {
  pool: Pool;
  authenticator: Authenticator;
  tags: TagService;
  starter: Pick<SuggestTagsStarter, "start">;
  /** At most 10 refreshes per user per minute (a model call each). */
  limiter: { tryAcquire(userId: string): boolean };
}

/** Accept, dismiss and refresh (spec section 5). A foreign, unknown or malformed document id all answer the same 404. */
export function suggestRoutes(deps: SuggestRoutesDeps): Record<string, Handler> {
  const auth = authed(deps.authenticator);
  const choose =
    (op: "accept" | "dismiss"): AuthedHandler =>
    async (req, res, identity, ctx) => {
      const body = await readJson(req, res, TagNameRequest);
      if (!body) return;
      const id = idOf(ctx.params.id);
      const view = id ? await deps.tags[op](identity, id, body.name) : null;
      if (!view) return notFound(res, "document");
      json(res, 200, view satisfies DocumentTagsResponse);
    };
  return {
    "POST /api/documents/:id/tag-suggestions/accept": auth(choose("accept")),
    "POST /api/documents/:id/tag-suggestions/dismiss": auth(choose("dismiss")),

    "POST /api/documents/:id/tag-suggestions/refresh": auth(async (_req, res, identity, ctx) => {
      const id = idOf(ctx.params.id);
      const row = id
        ? await withTenant(deps.pool, identity.tenantId, (tx) =>
            getDocument(tx, identity.userId, id),
          )
        : undefined;
      if (!row) return notFound(res, "document");
      // The button is disabled for this case; the server says so too, before it spends a model call.
      if (row.summary_enc == null)
        return sendError(
          res,
          409,
          "no_summary",
          "this document has no summary to suggest tags from",
        );
      if (!deps.limiter.tryAcquire(identity.userId)) {
        res.setHeader("retry-after", "60");
        return sendError(res, 429, "too_many_requests", "too many requests; try again in a minute");
      }
      const started = await deps.starter.start({
        tenantId: identity.tenantId,
        userId: identity.userId,
        documentId: row.id,
      });
      if (started.kind === "disabled")
        return sendError(res, 409, "suggest_unavailable", "tag suggestions are not available");
      if (started.kind === "running")
        return sendError(res, 409, "suggest_running", "tags for this document are being suggested");
      json(res, 202, { started: true } satisfies SuggestTagsResponse);
    }),
  };
}
