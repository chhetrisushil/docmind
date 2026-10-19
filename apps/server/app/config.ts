import { type PrincipalCryptoOptions, type StorageConfig, defineConfig } from "@loom/app";
import type { EventEnvelope } from "@loom/core";
import { type IngestDeps, ingestBeginEffect } from "./flows/ingest-document/deps";
import {
  agentModules,
  flowModules,
  projectionModules,
  skillModules,
  toolModules,
} from "./loom.gen";
import { authorizer, executionAuthorizer, principalCodec, resumeAuthenticator } from "./security";
import { isIngestExecution } from "./status/model";

/**
 * The composition root: the only place that picks an implementation for each interface.
 *
 * With `crypto` (the encrypting stores from `createDurableStorage`), Loom seals the principal's
 * identity in the log under the user's key. Without it (in-memory storage for the CLI and tests)
 * the identity is recorded as an opaque reference instead, which strict mode requires.
 *
 * `deps` are the outside-world dependencies of the flows, registered as effects (flows are static
 * modules, so this is the per-app injection point). A flow whose deps are missing fails at its step.
 */
export interface FlowDeps {
  ingest?: IngestDeps;
  /** Loom's `observability.onEvent`: the live feed of the ingest-status model. */
  onEvent?: (event: EventEnvelope) => void;
}

export function buildApp(
  storage: StorageConfig,
  crypto?: PrincipalCryptoOptions,
  deps: FlowDeps = {},
) {
  return defineConfig({
    storage,
    flowModules,
    agentModules,
    toolModules,
    skillModules,
    projectionModules,
    observability: { ...(deps.onEvent && { onEvent: deps.onEvent }) },
    // The status model folds each ingest execution's log from its first event, so compaction must never
    // remove an ingest execution's prefix (ADR 0132; plugins.md note 8). DocMind configures no retention yet.
    durability: { retention: { compactionExempt: isIngestExecution } },
    execution: {
      registerEffects: (effects) => {
        if (deps.ingest) effects.register("ingest-begin", ingestBeginEffect(deps.ingest));
      },
    },
    security: {
      strict: true,
      authorizer,
      executionAuthorizer,
      resumeAuthenticator,
      ...(crypto ? { crypto } : { principalCodec }),
    },
  });
}
