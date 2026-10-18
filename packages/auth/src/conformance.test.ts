import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Authenticator, Identity } from "./authenticator";
import { type AuthenticatorHarness, runAuthenticatorConformance } from "./conformance";

/** A bearer-token authenticator over a Map: the smallest thing that can pass the suite. */
function bearerHarness(): AuthenticatorHarness {
  const tokens = new Map<string, Identity>();
  const authenticator: Authenticator = {
    async authenticate(req) {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      return (token && tokens.get(token)) || null;
    },
  };
  return {
    authenticator,
    async issue(identity) {
      const token = randomUUID();
      tokens.set(token, identity);
      return { authorization: `Bearer ${token}` };
    },
    async revoke(headers: IncomingHttpHeaders) {
      tokens.delete(String(headers.authorization).replace(/^Bearer /, ""));
    },
    forged: () => ({ authorization: `Bearer ${randomUUID()}` }),
  };
}

runAuthenticatorConformance(bearerHarness, "bearer-token stub");
