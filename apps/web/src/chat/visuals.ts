/** The exact words of the Visuals strip and its action (spec section 8). */
export const VISUALS_COPY = {
  strip: "Visuals",
  visualize: "Visualize",
  visualizing: "Visualizing…",
  revisualize: "Re-visualize",
  limited: "Try again in a minute",
  nothing: "Nothing to visualize",
  failed: "Could not start. Try again.",
} as const;

/** How long "Visualizing…" waits for a `visuals` frame, and how long "Try again in a minute" stays. */
export const VISUALS_TIMEOUT_MS = 60_000;
/** How long "Could not start. Try again." stays (the action is back at once). */
export const VISUALS_FAILED_MS = 8_000;

export type VisualsPhase = "idle" | "running" | "limited" | "nothing" | "failed";
export interface VisualsView {
  strip: boolean;
  action: string | null;
  busy: boolean;
  note: string | null;
}

/**
 * What a message shows: null for anything but a complete, cited assistant answer (uncited, interrupted, failed, user).
 * The action is offered only when the server says the answer is `visualizable` (the visuals role is on); an existing strip shows regardless.
 */
export function visualsViewOf(e: {
  role: "user" | "assistant";
  status: string;
  citations: readonly unknown[];
  hasVisuals: boolean;
  visualizable: boolean;
  phase: VisualsPhase;
}): VisualsView | null {
  if (e.role !== "assistant" || e.status !== "complete" || e.citations.length === 0) return null;
  const idleAction = !e.visualizable
    ? null
    : e.hasVisuals
      ? VISUALS_COPY.revisualize
      : VISUALS_COPY.visualize;
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
    case "failed":
      return { strip: e.hasVisuals, action: idleAction, busy: false, note: VISUALS_COPY.failed };
    default:
      return { strip: e.hasVisuals, action: idleAction, busy: false, note: null };
  }
}
