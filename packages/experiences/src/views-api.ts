import type { SurfaceName, ViewName } from "@docmind/contracts";
import type { Experience } from "@loom-ui/core";
import {
  type HandleLoadRequest,
  type HandleLoadResult,
  defineDataProviders,
  publicFinding,
  serveHandles,
} from "@loom-ui/hydration";
import { TypedFailure } from "@loom/core";
import { DOCMIND_CATALOG } from "./catalog";
import { SURFACES } from "./catalog";
import { INVOKE_ID, type UiReaders, createInvoker } from "./invoker";
import {
  DetailCompileError,
  type ViewPayload,
  type ViewsOptions,
  createViewPayloads,
} from "./payload";
import { KIND, PINS } from "./providers";
import { reshapers } from "./reshapers";
import { EXPERIENCES, detailWithVisuals, turnWithVisuals } from "./views";
import { OWNER_READ, TURN_READ, mergedCatalog } from "./visuals";

const MAX_BATCH = 32;
/** Reads in flight at once for one POST: the app pool is shared with every other user. */
export const MAX_CONCURRENT_READS = 4;
/** What a finding reports for a handle the view does not bind: the client chose that text, so it is never logged. */
const UNBOUND = "unbound";

const providers = defineDataProviders([
  {
    kind: KIND,
    async invoke(call, invoker, opts) {
      if (call.expectedPin !== (PINS as Record<string, string>)[call.target])
        throw new TypedFailure("schemaDrift", {
          observedHash: (PINS as Record<string, string>)[call.target] ?? "",
        });
      return invoker.invokeTransient(INVOKE_ID, { target: call.target, args: call.args }, opts);
    },
  },
]);

export interface Views {
  names: readonly ViewName[];
  surfaces: readonly SurfaceName[];
  payload(name: ViewName, surface: SurfaceName): ViewPayload;
  /** The compiled detail of ONE document: the static detail plus its visuals (null: just the static detail). */
  documentPayload(
    documentId: string,
    visuals: Experience | null,
    surface: SurfaceName,
  ): ViewPayload;
  /**
   * The experience a document's detail page is served as: the static detail plus its visuals, or the static detail
   * alone when there are none or they do not compile (on any surface). `documentPayload` and a `{ document }` hydrate
   * both use this one decision, so the version hash a client holds is the one hydrate validates against.
   */
  documentExperience(documentId: string, visuals: Experience | null): Experience;
  /**
   * The experience a chat turn's visuals are served as, or null when there is nothing to show, a document is no longer
   * the user's, or the experience does not compile (on any surface). `turnPayload` and a `{ turn }` hydrate both use it.
   */
  turnExperience(
    turn: { chatId: string; ord: number },
    visuals: Experience | null,
    liveDocuments: ReadonlySet<string>,
  ): Experience | null;
  turnPayload(
    turn: { chatId: string; ord: number },
    visuals: Experience | null,
    liveDocuments: ReadonlySet<string>,
    surface: SurfaceName,
  ): ViewPayload | null;
  /**
   * Answers handle loads for an experience the caller was served. `scope` "view" (default) is a static view;
   * "document" is a `documentExperience` and "turn" a `turnExperience`, served to their owner under their clearance (R27).
   */
  hydrateExperience(
    experience: Experience,
    requests: readonly HandleLoadRequest[],
    readers: UiReaders,
    principalId: string,
    scope?: "view" | "document" | "turn",
  ): Promise<HandleLoadResult[]>;
  /** Answers handle loads for one view with the caller's readers. Surface-independent: values do not depend on how a view is drawn. */
  hydrate(
    name: ViewName,
    requests: readonly HandleLoadRequest[],
    readers: UiReaders,
    principalId: string,
  ): Promise<HandleLoadResult[]>;
}

export function createViews(o: ViewsOptions): Views {
  const base = createViewPayloads(o);
  const hydrateExperience: Views["hydrateExperience"] = async (
    experience,
    requests,
    readers,
    principalId,
    scope = "view",
  ) => {
    // A per-document detail or a turn uses the merged catalogue (it holds the visuals entries) and its owner's clearance.
    const owned = scope === "document" ? OWNER_READ : scope === "turn" ? TURN_READ : undefined;
    return [
      ...(await serveHandles(experience, requests, {
        invoker: createInvoker(readers),
        providers,
        reshapers,
        contentRefArgs: "none",
        outputKinds: { catalog: owned ? mergedCatalog() : DOCMIND_CATALOG, surface: "web" },
        ...(owned && {
          viewer: owned.viewer,
          audience: owned.audience,
          declaredToolClasses: owned.declaredToolClasses,
        }),
        principalId,
        now: Date.now(),
        maxBatch: MAX_BATCH,
        maxConcurrentCalls: MAX_CONCURRENT_READS,
        onFinding: (handle, finding) =>
          o.onFinding?.(
            Object.hasOwn(experience.providers, handle) ? handle : UNBOUND,
            publicFinding(undefined, finding).code,
          ),
      })),
    ];
  };
  const documentExperience: Views["documentExperience"] = (documentId, visuals) => {
    if (visuals === null) return EXPERIENCES.detail;
    try {
      const experience = detailWithVisuals(visuals, documentId);
      for (const surface of SURFACES) base.compileDetail(experience, surface);
      return experience;
    } catch (err) {
      // A model-derived experience that will not compile is not a server error: the page serves without it.
      // Finding codes only, never a message (it may name the model's labels).
      o.onFinding?.(
        UNBOUND,
        err instanceof DetailCompileError
          ? err.codes.join(",") || "compile-failed"
          : "compile-failed",
      );
      return EXPERIENCES.detail;
    }
  };
  const turnExperience: Views["turnExperience"] = (turn, visuals, liveDocuments) => {
    try {
      const experience = turnWithVisuals(visuals, turn, liveDocuments);
      if (experience === null) return null;
      for (const surface of SURFACES) base.compileTurn(experience, surface);
      return experience;
    } catch (err) {
      // Finding codes only, never a message (it may name the model's labels).
      o.onFinding?.(
        UNBOUND,
        err instanceof DetailCompileError
          ? err.codes.join(",") || "compile-failed"
          : "compile-failed",
      );
      return null;
    }
  };
  return {
    names: base.names,
    surfaces: base.surfaces,
    payload: base.payload,
    documentExperience,
    documentPayload: (documentId, visuals, surface) =>
      base.compileDetail(documentExperience(documentId, visuals), surface),
    turnExperience,
    turnPayload: (turn, visuals, liveDocuments, surface) => {
      const e = turnExperience(turn, visuals, liveDocuments);
      return e === null ? null : base.compileTurn(e, surface);
    },
    hydrateExperience,
    async hydrate(name, requests, readers, principalId) {
      if (!Object.hasOwn(EXPERIENCES, name)) {
        // An unknown view is a refusal of each request, never a throw and never an echo of the name.
        const finding = publicFinding(undefined, {
          code: "unknown-handle",
          severity: "error",
          message: "",
        });
        return requests.map(() => ({ state: "error" as const, finding }));
      }
      return hydrateExperience(EXPERIENCES[name], requests, readers, principalId);
    },
  };
}
