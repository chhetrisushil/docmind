import type { ServerResponse } from "node:http";
import type { Authenticator } from "@docmind/auth";
import {
  type DocumentTagsResponse,
  type ListTagsResponse,
  MAX_TAGS_PER_DOCUMENT,
  MAX_TAGS_PER_USER,
  SetDocumentTagsRequest,
  TagNameRequest,
  type TagResponse,
  Uuid,
} from "@docmind/contracts";
import { readJson } from "../http/body";
import { type AuthedHandler, requireAuth } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";
import {
  TagExistsError,
  TagLimitError,
  TagNameInvalidError,
  type TagService,
  UnknownTagError,
} from "./service";

export interface TagRoutesDeps {
  authenticator: Authenticator;
  tags: TagService;
}

/** A malformed id answers exactly like a missing or foreign one. */
export const idOf = (raw: string | undefined): string | null => {
  const p = Uuid.safeParse(raw);
  return p.success ? p.data.toLowerCase() : null;
};
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
export const notFound = (res: ServerResponse, what: string) =>
  sendError(res, 404, "not_found", `${what} not found`);

/** The service's errors as answers. Fixed texts: a tag name never reaches a message. */
export async function answering(res: ServerResponse, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    if (err instanceof TagLimitError)
      return sendError(
        res,
        409,
        "tag_limit",
        err.limit === "document"
          ? `a document holds at most ${MAX_TAGS_PER_DOCUMENT} tags`
          : `you can have at most ${MAX_TAGS_PER_USER} tags`,
      );
    if (err instanceof TagExistsError)
      return sendError(res, 409, "tag_exists", "a tag with this name already exists");
    if (err instanceof UnknownTagError) return sendError(res, 400, "invalid_tag", "unknown tag");
    if (err instanceof TagNameInvalidError)
      return sendError(res, 400, "invalid_request", "invalid tag name");
    throw err;
  }
}

/** A handler behind the session: tenant and user come from it, the answer is never cached (it carries decrypted names), the service's errors become answers. The one wrapper both route files use. */
export const authed =
  (authenticator: Authenticator) =>
  (handler: AuthedHandler): Handler =>
    requireAuth(authenticator, async (req, res, identity, ctx) => {
      res.setHeader("cache-control", "no-store");
      await answering(res, async () => void (await handler(req, res, identity, ctx)));
    });

/** The tag API (spec section 5). Every route takes tenant and user from the session. */
export function tagRoutes(deps: TagRoutesDeps): Record<string, Handler> {
  const auth = authed(deps.authenticator);
  const view = (res: ServerResponse, answer: Awaited<ReturnType<TagService["detail"]>>) =>
    answer ? json(res, 200, answer satisfies DocumentTagsResponse) : notFound(res, "document");

  return {
    "GET /api/tags": auth(async (_req, res, identity) => {
      json(res, 200, { tags: await deps.tags.list(identity) } satisfies ListTagsResponse);
    }),

    "POST /api/tags": auth(async (req, res, identity) => {
      const body = await readJson(req, res, TagNameRequest);
      if (!body) return;
      const { tag, created } = await deps.tags.create(identity, body.name);
      json(res, created ? 201 : 200, { tag } satisfies TagResponse);
    }),

    "PATCH /api/tags/:id": auth(async (req, res, identity, ctx) => {
      const body = await readJson(req, res, TagNameRequest);
      if (!body) return;
      const id = idOf(ctx.params.id);
      const tag = id ? await deps.tags.rename(identity, id, body.name) : null;
      if (!tag) return notFound(res, "tag");
      json(res, 200, { tag } satisfies TagResponse);
    }),

    "DELETE /api/tags/:id": auth(async (_req, res, identity, ctx) => {
      const id = idOf(ctx.params.id);
      if (!id || !(await deps.tags.remove(identity, id))) return notFound(res, "tag");
      res.writeHead(204);
      res.end();
    }),

    "PUT /api/documents/:id/tags": auth(async (req, res, identity, ctx) => {
      const body = await readJson(req, res, SetDocumentTagsRequest);
      if (!body) return;
      const id = idOf(ctx.params.id);
      view(res, id ? await deps.tags.setForDocument(identity, id, body.tagIds) : null);
    }),

    "POST /api/documents/:id/tags": auth(async (req, res, identity, ctx) => {
      const body = await readJson(req, res, TagNameRequest);
      if (!body) return;
      const id = idOf(ctx.params.id);
      view(res, id ? await deps.tags.addToDocument(identity, id, body.name) : null);
    }),

    "DELETE /api/documents/:id/tags/:tagId": auth(async (_req, res, identity, ctx) => {
      const id = idOf(ctx.params.id);
      // A malformed tag id is an unknown one: removing it is an idempotent no-op, as for any id the document lacks.
      const tagId = idOf(ctx.params.tagId) ?? NIL_UUID;
      view(res, id ? await deps.tags.removeFromDocument(identity, id, tagId) : null);
    }),
  };
}
