import { runContentStoreConformance } from "@loom/conformance";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { afterAll } from "vitest";
import { EncryptedFsContentStore } from "./EncryptedFsContentStore";
import { cleanupRoots, freshRoot } from "./testing/tempRoot";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

afterAll(cleanupRoots);

const newStore = (maxBytes?: number) =>
  new EncryptedFsContentStore({
    root: freshRoot(),
    tenantId: TENANT,
    userId: USER,
    keys: new InMemoryKeyStore(),
    maxBytes,
  });

// The same contract every ContentStore owes (Loom ADR 0046), run on a fresh directory each time.
// The addresses are keyed (hmac-sha256:), which the kit accepts: it only compares them with each other.
runContentStoreConformance(() => newStore(), "EncryptedFsContentStore");
