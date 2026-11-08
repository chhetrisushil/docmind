/** The exact words of the Visuals strip and its action (spec section 8). */
export const VISUALS_COPY = {
  strip: "Visuals",
  visualize: "Visualize",
  visualizing: "Visualizing…",
  revisualize: "Re-visualize",
  limited: "Try again in a minute",
  nothing: "Nothing to visualize",
} as const;

/** How long "Visualizing…" waits for a `visuals` frame, and how long "Try again in a minute" stays. */
export const VISUALS_TIMEOUT_MS = 60_000;

export type VisualsPhase = "idle" | "running" | "limited" | "nothing";
export interface VisualsView {
  strip: boolean;
  action: string | null;
  busy: boolean;
  note: string | null;
}

/** What a message shows: null for anything but a complete, cited assistant answer (uncited, interrupted, failed, user). */
export function visualsViewOf(e: {
  role: "user" | "assistant";
  status: string;
  citations: readonly unknown[];
  hasVisuals: boolean;
  phase: VisualsPhase;
}): VisualsView | null {
  if (e.role !== "assistant" || e.status !== "complete" || e.citations.length === 0) return null;
  const idleAction = e.hasVisuals ? VISUALS_COPY.revisualize : VISUALS_COPY.visualize;
  switch (e.phase) {
    case "running":
      return { strip: e.hasVisuals, action: VISUALS_COPY.visualizing, busy: true, note: null };
    case "limited":
      return { strip: e.hasVisuals, action: null, busy: false, note: VISUALS_COPY.limited };
    case "nothing":
      // Ruling C1: a re-run that ends nothing keeps the earlier visuals, so the note is for a turn with no strip only.
      return {
        strip: e.hasVisuals,
        action: idleAction,
        busy: false,
        note: e.hasVisuals ? null : VISUALS_COPY.nothing,
      };
    default:
      return { strip: e.hasVisuals, action: idleAction, busy: false, note: null };
  }
}
