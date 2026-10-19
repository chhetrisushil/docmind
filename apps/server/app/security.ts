import { createHash } from "node:crypto";
import { GrantTable, type PrincipalChain } from "@loom/effect-runtime";
import {
  type ExecutionAuthorizer,
  type PrincipalCodec,
  executionAccessPolicy,
  signedResumeAuthenticator,
} from "@loom/workflow-runtime";

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
});

// The actor that starts an execution owns it; only that actor, in the same tenant, may resume,
// cancel or read it.
export const executionAuthorizer: ExecutionAuthorizer = executionAccessPolicy({
  requireTenant: true,
  rules: { start: "any", resume: "owner", cancel: "owner", query: "owner" },
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
