import { z } from "zod";

/** The experiences DocMind composes (Task 186b). */
export const ViewName = z.enum([
  "library",
  "library-empty",
  "detail",
  "sessions",
  "chat",
  "sources",
]);
export type ViewName = z.infer<typeof ViewName>;

/** The surfaces an experience is compiled for. A new surface adds a value here and a key per catalogue entry. */
export const SurfaceName = z.enum(["web", "terminal"]);
export type SurfaceName = z.infer<typeof SurfaceName>;

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** `GET /api/ui/views/:view?surface=`: the compiled blueprint and the handle inventory; never a provider, never data. */
export const UiViewResponse = z.object({
  view: ViewName,
  surface: SurfaceName,
  experienceId: z.string(),
  versionHash: z.string(),
  blueprint: z.record(z.unknown()),
  inventory: z.object({
    experienceId: z.string(),
    versionHash: z.string(),
    handles: z.array(
      z.object({
        handle: z.string(),
        priority: z.enum(["P0", "P1", "P2"]),
        params: z.array(z.string()),
        revision: z.string(),
        finding: z.record(z.unknown()).optional(),
      }),
    ),
  }),
  fingerprint: z
    .object({
      audience: z.string().optional(),
      restrictedHandles: z.array(z.string()),
      restrictedProjectionNodes: z.array(z.string()),
      placeholderNodes: z.array(z.string()),
    })
    .passthrough(),
});
export type UiViewResponse = z.infer<typeof UiViewResponse>;

/** `POST /api/ui/hydrate`: loom-ui `HandleLoadRequest`s for one view (1 to 32 per call). */
export const UiHydrateRequest = z.object({
  view: ViewName,
  requests: z
    .array(
      z.object({
        experienceId: z.string(),
        versionHash: z.string(),
        handle: z.string(),
        params: z.record(Scalar),
      }),
    )
    .min(1)
    .max(32),
});
export type UiHydrateRequest = z.infer<typeof UiHydrateRequest>;

/** One loom-ui `HandleLoadResult` per request, in order. The browser's split controller validates each result itself. */
export const UiHydrateResponse = z.object({ results: z.array(z.unknown()) });
export type UiHydrateResponse = z.infer<typeof UiHydrateResponse>;
