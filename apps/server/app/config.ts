import { defineConfig } from "@loom/app";
import {
  agentModules,
  flowModules,
  projectionModules,
  skillModules,
  toolModules,
} from "./loom.gen";
import { authorizer, executionAuthorizer, principalCodec, resumeAuthenticator } from "./security";

// The composition root: the only place that picks an implementation for each interface.
export const app = defineConfig({
  storage: { kind: "memory" },
  flowModules,
  agentModules,
  toolModules,
  skillModules,
  projectionModules,
  security: { strict: true, authorizer, executionAuthorizer, resumeAuthenticator, principalCodec },
});
