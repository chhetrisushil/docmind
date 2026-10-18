import type { IncomingMessage } from "node:http";

/** Who a request is from. Both ids come from the server's own records, never from the client. */
export interface Identity {
  tenantId: string;
  userId: string;
}

/** The only part of a request an Authenticator may read. */
export type AuthRequest = Pick<IncomingMessage, "headers">;

/**
 * Turns a request into an Identity. The password/session implementation is the v1 one; AetherOS
 * platform identity replaces it later without touching a route.
 *
 * Contract: resolve `null` for any request that is not authenticated (no credential, a forged or
 * expired or revoked one, garbage). Reject only when the check itself could not run (database
 * down); the router turns that into a 500, never into a 401 and never into access.
 */
export interface Authenticator {
  authenticate(req: AuthRequest): Promise<Identity | null>;
}
