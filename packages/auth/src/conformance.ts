import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import type { Authenticator, Identity } from "./authenticator";

/** What the suite needs from an implementation, since credentials differ per implementation. */
export interface AuthenticatorHarness {
  authenticator: Authenticator;
  /** Makes `identity` a valid caller and returns the request headers that carry its credential. */
  issue(identity: Identity): Promise<IncomingHttpHeaders>;
  /** Invalidates a credential `issue` returned (logout, expiry, revocation). */
  revoke(headers: IncomingHttpHeaders): Promise<void>;
  /** Headers shaped like a credential of this implementation that was never issued. */
  forged(): IncomingHttpHeaders;
}

const ALICE: Identity = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
};
const BOB: Identity = {
  tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  userId: "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1",
};

/** The suite every Authenticator implementation must pass. Call it from the implementation's test. */
export function runAuthenticatorConformance(
  make: () => AuthenticatorHarness | Promise<AuthenticatorHarness>,
  label = "Authenticator",
): void {
  describe(`${label} conformance`, () => {
    it("returns null for a request with no credential", async () => {
      const { authenticator } = await make();
      expect(await authenticator.authenticate({ headers: {} })).toBeNull();
    });

    it("returns null for a credential that was never issued", async () => {
      const h = await make();
      expect(await h.authenticator.authenticate({ headers: h.forged() })).toBeNull();
    });

    it("returns exactly the issued identity, and nothing else", async () => {
      const h = await make();
      const headers = await h.issue(ALICE);
      expect(await h.authenticator.authenticate({ headers })).toEqual(ALICE);
    });

    it("keeps two callers apart", async () => {
      const h = await make();
      const alice = await h.issue(ALICE);
      const bob = await h.issue(BOB);
      expect(await h.authenticator.authenticate({ headers: alice })).toEqual(ALICE);
      expect(await h.authenticator.authenticate({ headers: bob })).toEqual(BOB);
    });

    it("returns null once the credential is revoked, and leaves other callers alone", async () => {
      const h = await make();
      const alice = await h.issue(ALICE);
      const bob = await h.issue(BOB);
      await h.revoke(alice);
      expect(await h.authenticator.authenticate({ headers: alice })).toBeNull();
      expect(await h.authenticator.authenticate({ headers: bob })).toEqual(BOB);
    });
  });
}
