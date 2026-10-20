import { createHash } from "node:crypto";
import { GrantTable, type PrincipalChain } from "@loom/effect-runtime";
import {
  type ExecutionAccessPolicy,
  type PrincipalCodec,
  executionAccessPolicy,
  signedResumeAuthenticator,
} from "@loom/workflow-runtime";
import { CHAT_EFFECT_IDS, CHAT_FLOW_ID, CHAT_GK_FLOW_ID, CHAT_TITLE_FLOW_ID } from "./chats/ids";

// What `security.strict` refuses to start without. The table is keyed by workflow id; every flow
// added later lists its step ids here (a step id doubles as its tool id).
export const authorizer = new GrantTable({
  "ingest-document": [
    "ingest-parse",
    "ingest-chunk",
    "ingest-embed",
    "ingest-analyze",
    "ingest-summarize",
    "ingest-link",
    "ingest-finalize",
  ],
  // A conversation's effects (the model call and the five read-only tools) run under the flow id.
  [CHAT_FLOW_ID]: CHAT_EFFECT_IDS,
  [CHAT_GK_FLOW_ID]: CHAT_EFFECT_IDS,
  // The one-step title flow (Task 154); the step id is its tool id.
  [CHAT_TITLE_FLOW_ID]: ["chat-title"],
});

// The actor that starts an execution owns it; only that actor, in the same tenant, may resume,
// cancel or read it.
export const executionAuthorizer: ExecutionAccessPolicy = executionAccessPolicy({
  requireTenant: true,
  // `send` is the one Loom's createConversations also requires to be owner-scoped (conversations.ts
  // POLICED_OPS): a tenant peer must not be able to message another user's chat. The other policed ops
  // (actAsOwner, annotate, discard, quarantine, release) are already owner or deny by default.
  rules: { start: "any", resume: "owner", cancel: "owner", query: "owner", send: "owner" },
});

// For the in-memory app only (the CLI and tests): the log stores an opaque ref, never a tenant or
// actor verbatim. The durable app does not use this; it seals the identity under the user's key
// instead (`security.crypto`, see config.ts).
const principals = new Map<string, PrincipalChain>();
export const principalCodec: PrincipalCodec = {
  toRef(chain) {
    const ref = `p:${createHash("sha256").update(JSON.stringify(chain)).digest("hex").slice(0, 32)}`;
    principals.set(ref, chain);
    return ref;
  },
  fromRef: (ref) => principals.get(ref),
};

// No gate in M0 is approvable: with no key configured every actor fails closed.
export const resumeAuthenticator = signedResumeAuthenticator({
  gates: ["AgentToolApproval", "ApprovalGranted"],
  keys: () => undefined,
});
