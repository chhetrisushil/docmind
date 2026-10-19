import type { StepDefinition } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import { sensitivePathsFromSteps } from "@loom/plugin-crypto";
import { type SensitiveMap, mergeSensitive, sensitiveMapFromCovers } from "@loom/plugin-read-model";
import { ingestDocumentFlow } from "../flows/ingest-document/flow";

/** The steps of every flow the app registers. Add a flow here so its `sensitive(...)` outputs reach the model's guard (ADR 0132 D11). */
export const flowSteps = (): readonly StepDefinition[] =>
  [ingestDocumentFlow].flatMap((flow) => flow.definition.steps);

/**
 * The paths a folded handler must never see: the steps' `sensitive(...)` outputs UNION what the
 * encrypting store seals. Call it after `defineConfig`: only then have the framework-sealed paths
 * (`EXECUTION_STARTED` `principal.identity.*`, `OUTCOME_RECORDED.recordedBy`) been registered.
 */
export const statusSensitive = (
  steps: readonly StepDefinition[],
  store: Pick<EventStore, "sealingCapability">,
): SensitiveMap =>
  mergeSensitive(
    sensitivePathsFromSteps(steps),
    sensitiveMapFromCovers(store.sealingCapability?.()?.covers ?? []),
  );
