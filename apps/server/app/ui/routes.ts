import type { Authenticator, Identity } from "@docmind/auth";
import {
  SurfaceName,
  UiHydrateRequest,
  type UiHydrateResponse,
  type UiViewResponse,
  ViewName,
} from "@docmind/contracts";
import { Uuid } from "@docmind/contracts";
import type { UiReaders, Views } from "@docmind/experiences";
import type { Experience } from "@loom-ui/core";
import type { Lineage } from "@loom-ui/lineage";
import { withTenant } from "../db/tenant";
import { getDocument } from "../documents/repo";
import { experienceIdOf } from "../flows/visualize-document/lineage";
import { readJson } from "../http/body";
import { requireAuth } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";
import { type UiReaderDeps, readersFor as realReadersFor } from "./readers";

export interface UiRouteDeps {
  authenticator: Authenticator;
  views: Views;
  readers: UiReaderDeps;
  /** The visuals lineage (the one the visualize flow commits to): its head is the document's visuals. */
  lineage: Lineage;
  /** Test seam: replaces the owner check (default: the document is the caller's, tenant-scoped, as `GET /api/documents/:id`). */
  owns?: (identity: Identity, documentId: string) => Promise<boolean>;
  /** Test seam: replaces the identity-bound readers. */
  readersFor?: (identity: Identity) => UiReaders;
}

/** Every answer of a UI route, 401 and errors included, is uncacheable. */
const noStore =
  (value: string, handler: Handler): Handler =>
  (req, res, ctx) => {
    res.setHeader("cache-control", value);
    return handler(req, res, ctx);
  };

/** `GET /api/ui/views/:view` (the compiled view) and `POST /api/ui/hydrate` (its data). Both take the caller from the session only. */
export function uiRoutes(deps: UiRouteDeps): Record<string, Handler> {
  const readers =
    deps.readersFor ?? ((identity: Identity) => realReadersFor(deps.readers, identity));
  const owns =
    deps.owns ??
    (async (identity: Identity, id: string) =>
      Boolean(
        await withTenant(deps.readers.pool, identity.tenantId, (tx) =>
          getDocument(tx, identity.userId, id),
        ),
      ));
  /** The document's visuals head, or null when there is none (empty, erased or unreadable lines all serve the static detail). */
  const headOf = async (identity: Identity, documentId: string): Promise<Experience | null> => {
    try {
      const latest = await deps.lineage.resolveLatest(
        experienceIdOf({ tenantId: identity.tenantId, userId: identity.userId, documentId }),
      );
      return latest.ok ? latest.value : null;
    } catch (err) {
      console.error(
        "visuals head unavailable",
        err instanceof Error ? err.constructor.name : typeof err,
      );
      return null;
    }
  };
  const surfaceOf = (req: { url?: string }) =>
    SurfaceName.safeParse(
      new URL(req.url ?? "/", "http://localhost").searchParams.get("surface") ?? "web",
    );
  return {
    "GET /api/ui/documents/:id/detail": noStore(
      "private, no-store",
      requireAuth(deps.authenticator, async (req, res, identity, ctx) => {
        const parsed = Uuid.safeParse(ctx.params.id);
        // A malformed id answers exactly like a missing or foreign one, and the owner is checked before anything else.
        const id = parsed.success ? parsed.data.toLowerCase() : null;
        if (!id || !(await owns(identity, id)))
          return sendError(res, 404, "not_found", "document not found");
        const surface = surfaceOf(req);
        if (!surface.success) return sendError(res, 400, "invalid_request", "unknown surface");
        const payload = deps.views.documentPayload(id, await headOf(identity, id), surface.data);
        json(res, 200, payload as unknown as UiViewResponse);
      }),
    ),

    "GET /api/ui/views/:view": noStore(
      "private, no-store",
      requireAuth(deps.authenticator, async (req, res, _identity, ctx) => {
        const view = ViewName.safeParse(ctx.params.view);
        if (!view.success) return sendError(res, 404, "not_found", "view not found");
        const surface = surfaceOf(req);
        if (!surface.success) return sendError(res, 400, "invalid_request", "unknown surface");
        json(res, 200, deps.views.payload(view.data, surface.data) as unknown as UiViewResponse);
      }),
    ),

    "POST /api/ui/hydrate": noStore(
      "no-store",
      requireAuth(deps.authenticator, async (req, res, identity) => {
        const body = await readJson(req, res, UiHydrateRequest, { maskKeysUnder: ["params"] });
        if (!body) return;
        let results: UiHydrateResponse["results"];
        if ("view" in body) {
          results = await deps.views.hydrate(
            body.view,
            body.requests,
            readers(identity),
            identity.userId,
          );
        } else if ("turn" in body) {
          // Task 10 serves a turn's visuals here; until then no turn has any.
          return sendError(res, 404, "not_found", "turn not found");
        } else {
          const id = body.document.toLowerCase();
          if (!(await owns(identity, id)))
            return sendError(res, 404, "not_found", "document not found");
          results = await deps.views.hydrateExperience(
            deps.views.documentExperience(id, await headOf(identity, id)),
            body.requests,
            readers(identity),
            identity.userId,
            "document",
          );
        }
        json(res, 200, { results } satisfies UiHydrateResponse);
      }),
    ),
  };
}
