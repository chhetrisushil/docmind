import { type PrincipalCryptoOptions, type StorageConfig, defineConfig } from "@loom/app";
import type { EventEnvelope } from "@loom/core";
import type { Effect } from "@loom/effect-runtime";
import type { TimerStore } from "@loom/event-runtime";
import type { RegisteredFlow } from "@loom/workflow-runtime";
import { type IngestDeps, ingestEffects } from "./flows/ingest-document/deps";
import {
  agentModules,
  flowModules,
  projectionModules,
  skillModules,
  toolModules,
} from "./loom.gen";
import { authorizer, executionAuthorizer, principalCodec, resumeAuthenticator } from "./security";
import { isIngestExecution } from "./status/model";

/** What the chat needs registered on the Loom app (built by `prepareChat`, chats/wiring.ts). */
export interface ChatDeps {
  /** Both chat flows (strict and general knowledge): a recovered conversation must find its flow at boot. */
  flows: readonly RegisteredFlow[];
  /** `chat-model` (only with an API key) and the five tools, by effect id. */
  effects: Readonly<Record<string, Effect>>;
  /** The durable timers the inbox needs to wake a parked conversation. */
  timers: TimerStore;
}

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
  chat?: ChatDeps;
  /** Loom's `observability.onEvent`: the live feed of the ingest-status model. */
  onEvent?: (event: EventEnvelope) => void;
}

export function buildApp(
  storage: StorageConfig,
  crypto?: PrincipalCryptoOptions,
  deps: FlowDeps = {},
) {
  // A conversation parks on the inbox and rotates with continue-as-new; the inbox needs durable timers.
  const chat = deps.chat
    ? {
        flows: [...deps.chat.flows],
        timers: { store: deps.chat.timers },
        kernel: { features: { inbox: true, continueAsNew: true } },
      }
    : {};
  return defineConfig({
    storage,
    flowModules,
    agentModules,
    toolModules,
    skillModules,
    projectionModules,
    ...chat,
    observability: { ...(deps.onEvent && { onEvent: deps.onEvent }) },
    // The status model folds each ingest execution's log from its first event, so compaction must never
    // remove an ingest execution's prefix (ADR 0132; plugins.md note 8). DocMind configures no retention yet.
    // Eager heartbeat leases: an ingest runs for seconds, so Loom's default lazy lease (taken only after a
    // run has gone TTL/3 unleased) would leave a fresh execution unvetoed against recovery on another node.
    durability: {
      retention: { compactionExempt: isIngestExecution },
      heartbeat: { acquire: "eager" },
    },
    execution: {
      registerEffects: (effects) => {
        if (deps.ingest) {
          for (const [id, effect] of Object.entries(ingestEffects(deps.ingest))) {
            effects.register(id, effect);
          }
        }
        if (deps.chat) {
          for (const [id, effect] of Object.entries(deps.chat.effects))
            effects.register(id, effect);
        }
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
