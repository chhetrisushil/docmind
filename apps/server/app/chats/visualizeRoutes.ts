import { ORD_PATTERN, RecordOrd, type VisualizeTurnResponse } from "@docmind/contracts";
import { TurnGoneError } from "../flows/visualize-turn/errors";
import { requireAuth } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";
import { loadChat, notFound } from "./access";
import type { ChatRouteDeps } from "./routes";

const ORD = new RegExp(`^${ORD_PATTERN}$`); // canonical decimal: no sign, no leading zero, no fraction

/** On-demand visuals for one turn. A foreign chat, an unknown one and a deleted one all answer the same 404. */
export function chatVisualizeRoutes(deps: ChatRouteDeps): Record<string, Handler> {
  const v = deps.visualize;
  if (!v) return {};
  return {
    "POST /api/chats/:id/turns/:ord/visualize": requireAuth(
      deps.authenticator,
      async (_req, res, identity, ctx) => {
        const chat = await loadChat(deps, identity, ctx); // owner, tenant, not soft-deleted
        const ordText = ctx.params.ord ?? "";
        const ord = ORD.test(ordText) ? RecordOrd.safeParse(Number(ordText)) : null;
        if (!chat || !ord?.success) return notFound(res);
        if (!v.limiter.tryAcquire(identity.userId)) {
          res.setHeader("retry-after", "60");
          return sendError(
            res,
            429,
            "too_many_requests",
            "too many visualize requests; try again in a minute",
          );
        }
        const ref = {
          tenantId: identity.tenantId,
          userId: identity.userId,
          chatId: chat.id,
          ord: ord.data,
        };
        const turn = await v.turn.read(ref);
        if (turn?.status === "too_old")
          return sendError(
            res,
            409,
            "not_visualizable",
            "this answer is too far back in the chat to make visuals for",
          );
        if (!turn || turn.status !== "complete" || turn.citations.length === 0)
          return sendError(res, 409, "not_visualizable", "this answer has no visuals to make");
        let started: Awaited<ReturnType<typeof v.starter.visualize>>;
        try {
          started = await v.starter.visualize(ref);
        } catch (err) {
          if (err instanceof TurnGoneError) return notFound(res); // the chat went (deleted or erased) after the turn was read
          throw err;
        }
        if (started.kind === "disabled")
          return sendError(res, 409, "not_visualizable", "this answer has no visuals to make");
        if (started.kind === "running")
          return sendError(res, 409, "visualize_running", "visuals for this answer are being made");
        json(res, 202, { started: true } satisfies VisualizeTurnResponse);
      },
    ),
  };
}
