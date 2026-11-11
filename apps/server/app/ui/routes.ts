import type { Authenticator, Identity } from "@docmind/auth";
import {
  SurfaceName,
  UiHydrateRequest,
  type UiHydrateResponse,
  type UiViewResponse,
  ViewName,
} from "@docmind/contracts";
import { ORD_PATTERN, Uuid } from "@docmind/contracts";
import { type UiReaders, type Views, documentsOfVisuals } from "@docmind/experiences";
import type { Experience } from "@loom-ui/core";
import type { Lineage } from "@loom-ui/lineage";
import type { ChatIdResolver } from "../chats/chatIds";
import { getChat } from "../chats/sessions";
import { withTenant } from "../db/tenant";
import {
  type UserIdSource,
  documentLineageCandidates,
  existingUser,
} from "../documents/executionCandidates";
import { getDocument } from "../documents/repo";
import type { VisualsStateReader } from "../flows/visualize-document/state";
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
  /** The document's line is looked up under both id formats, the new one first. */
  ids: Pick<UserIdSource, "load" | "cached">;
  /** Builds a turn's lineage id in its chat's own format. */
  chatIds: Pick<ChatIdResolver, "forRef">;
  /** Where the document's visuals stand (`visuals: { state }` on its detail). Absent: the detail carries none (a deployment without the visuals flow). */
  visualsState?: VisualsStateReader;
  /** Test seam: replaces the owner check (default: the document is the caller's, tenant-scoped, as `GET /api/documents/:id`). */
  owns?: (identity: Identity, documentId: string) => Promise<boolean>;
  /** Test seam: replaces the chat owner check (default: the chat is the caller's and not soft-deleted). */
  ownsChat?: (identity: Identity, chatId: string) => Promise<boolean>;
  /** Test seam: the ids among `ids` that are the caller's documents (default: one owner-scoped query). */
  ownedDocuments?: (identity: Identity, ids: string[]) => Promise<Set<string>>;
  /** Test seam: replaces the identity-bound readers. */
  readersFor?: (identity: Identity) => UiReaders;
}

/** The ids among `ids` that are the caller's documents right now (owner-scoped, one query): a foreign or deleted document is left out. */
export async function ownedDocumentIds(
  pool: UiReaderDeps["pool"],
  identity: Identity,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set<string>();
  const { rows } = await withTenant(pool, identity.tenantId, (tx) =>
    tx.query<{ id: string }>(
      "SELECT id FROM documents WHERE owner_id = $1 AND id = ANY($2::uuid[])",
      [identity.userId, ids],
    ),
  );
  return new Set(rows.map((r) => r.id));
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
      // The new-format line first; a document visualized before the deploy still has its old-format line.
      const user = await existingUser(deps.ids, identity);
      for (const experienceId of documentLineageCandidates(identity.userId, documentId, user)) {
        const latest = await deps.lineage.resolveLatest(experienceId);
        if (latest.ok) return latest.value;
      }
      return null;
    } catch (err) {
      console.error(
        "visuals head unavailable",
        err instanceof Error ? err.constructor.name : typeof err,
      );
      return null;
    }
  };
  const ownsChat =
    deps.ownsChat ??
    (async (identity: Identity, id: string) =>
      Boolean(
        await withTenant(deps.readers.pool, identity.tenantId, (tx) =>
          getChat(tx, identity.userId, id),
        ),
      ));
  const ownedDocuments =
    deps.ownedDocuments ??
    ((identity: Identity, ids: string[]) => ownedDocumentIds(deps.readers.pool, identity, ids));
  const ORD = new RegExp(`^${ORD_PATTERN}$`); // RecordOrd: up to 15 digits, the range of ChatMessageDto.id
  /** The turn's visuals head and the documents of it that are still the caller's; null when there is no head. */
  const turnHead = async (identity: Identity, chatId: string, ord: number) => {
    let visuals: Experience;
    try {
      const ids = await deps.chatIds.forRef({
        tenantId: identity.tenantId,
        userId: identity.userId,
        chatId,
      });
      if (!ids) return null; // not the owner's chat: no head
      const latest = await deps.lineage.resolveLatest(ids.turnExperienceId(ord));
      if (!latest.ok) return null;
      visuals = latest.value;
    } catch (err) {
      console.error(
        "turn visuals head unavailable",
        err instanceof Error ? err.constructor.name : typeof err,
      );
      return null;
    }
    let owned: Set<string>;
    try {
      owned = new Set(await ownedDocuments(identity, documentsOfVisuals(visuals)));
    } catch (err) {
      // A database failure is not an absent head: logged apart, and rethrown so the route answers 500 (as `owns` does).
      console.error(
        "turn visuals documents lookup failed",
        err instanceof Error ? err.constructor.name : typeof err,
      );
      throw err;
    }
    // the pins name documents in lowercase; so does the set they are looked up in
    return { visuals, live: new Set([...owned].map((d) => d.toLowerCase())) };
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
        const head = await headOf(identity, id);
        const payload = deps.views.documentPayload(id, head, surface.data);
        const visuals = deps.visualsState
          ? { visuals: { state: await deps.visualsState(identity, id, head !== null) } }
          : {};
        json(res, 200, { ...payload, ...visuals } as unknown as UiViewResponse);
      }),
    ),

    "GET /api/ui/chats/:id/turns/:ord/visuals": noStore(
      "private, no-store",
      requireAuth(deps.authenticator, async (req, res, identity, ctx) => {
        const parsed = Uuid.safeParse(ctx.params.id);
        const ordText = ctx.params.ord ?? "";
        const chatId = parsed.success ? parsed.data.toLowerCase() : null;
        // A malformed id or ord answers exactly like a missing or foreign one; the owner is checked before anything else.
        if (!chatId || !ORD.test(ordText) || !(await ownsChat(identity, chatId)))
          return sendError(res, 404, "not_found", "visuals not found");
        const surface = surfaceOf(req);
        if (!surface.success) return sendError(res, 400, "invalid_request", "unknown surface");
        const turn = { chatId, ord: Number(ordText) };
        const head = await turnHead(identity, chatId, turn.ord);
        const payload = head && deps.views.turnPayload(turn, head.visuals, head.live, surface.data);
        if (!payload) return sendError(res, 404, "not_found", "visuals not found");
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
          const chatId = body.turn.chatId.toLowerCase();
          if (!(await ownsChat(identity, chatId)))
            return sendError(res, 404, "not_found", "visuals not found");
          const head = await turnHead(identity, chatId, body.turn.ord);
          const experience =
            head &&
            deps.views.turnExperience({ chatId, ord: body.turn.ord }, head.visuals, head.live);
          if (!experience) return sendError(res, 404, "not_found", "visuals not found");
          results = await deps.views.hydrateExperience(
            experience,
            body.requests,
            readers(identity),
            identity.userId,
            "turn",
          );
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
