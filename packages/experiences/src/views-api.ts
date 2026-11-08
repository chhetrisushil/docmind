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
import { INVOKE_ID, type UiReaders, createInvoker } from "./invoker";
import { type ViewPayload, type ViewsOptions, createViewPayloads } from "./payload";
import { KIND, PINS } from "./providers";
import { reshapers } from "./reshapers";
import { EXPERIENCES, detailWithVisuals } from "./views";
import { mergedCatalog } from "./visuals";

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
  /** Answers handle loads for an experience the caller was served (a static view's, or a document's `detailWithVisuals`). */
  hydrateExperience(
    experience: Experience,
    requests: readonly HandleLoadRequest[],
    readers: UiReaders,
    principalId: string,
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
  ) => {
    // A per-document detail uses the merged catalogue (it holds the visuals entries); a static view the plain one.
    const catalog = Object.values(EXPERIENCES).includes(experience)
      ? DOCMIND_CATALOG
      : mergedCatalog();
    return [
      ...(await serveHandles(experience, requests, {
        invoker: createInvoker(readers),
        providers,
        reshapers,
        contentRefArgs: "none",
        outputKinds: { catalog, surface: "web" },
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
  return {
    names: base.names,
    surfaces: base.surfaces,
    payload: base.payload,
    documentPayload: (documentId, visuals, surface) =>
      base.compileDetail(detailWithVisuals(visuals, documentId), surface),
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
