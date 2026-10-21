import type { Authenticator, Identity } from "@docmind/auth";
import {
  SurfaceName,
  UiHydrateRequest,
  type UiHydrateResponse,
  type UiViewResponse,
  ViewName,
} from "@docmind/contracts";
import type { UiReaders, Views } from "@docmind/experiences";
import { readJson } from "../http/body";
import { requireAuth } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";
import { type UiReaderDeps, readersFor as realReadersFor } from "./readers";

export interface UiRouteDeps {
  authenticator: Authenticator;
  views: Views;
  readers: UiReaderDeps;
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
  return {
    "GET /api/ui/views/:view": noStore(
      "private, no-store",
      requireAuth(deps.authenticator, async (req, res, _identity, ctx) => {
        const view = ViewName.safeParse(ctx.params.view);
        if (!view.success) return sendError(res, 404, "not_found", "view not found");
        const surface = SurfaceName.safeParse(
          new URL(req.url ?? "/", "http://localhost").searchParams.get("surface") ?? "web",
        );
        if (!surface.success) return sendError(res, 400, "invalid_request", "unknown surface");
        json(res, 200, deps.views.payload(view.data, surface.data) as unknown as UiViewResponse);
      }),
    ),

    "POST /api/ui/hydrate": noStore(
      "no-store",
      requireAuth(deps.authenticator, async (req, res, identity) => {
        const body = await readJson(req, res, UiHydrateRequest, { maskKeysUnder: ["params"] });
        if (!body) return;
        const results = await deps.views.hydrate(
          body.view,
          body.requests,
          readers(identity),
          identity.userId,
        );
        json(res, 200, { results } satisfies UiHydrateResponse);
      }),
    ),
  };
}
