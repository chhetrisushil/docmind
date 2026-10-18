import { createHash } from "node:crypto";

/**
 * How failures slow a caller down. The first `free` failures cost nothing; each one after that
 * locks the key for `baseSeconds * 2^(n - free - 1)`, never more than `capSeconds`, so a lock is
 * always time-boxed: waiting it out is enough, and nobody is locked out for good. A key left
 * alone for `decaySeconds` starts again from zero.
 */
export interface ThrottlePolicy {
  free: number;
  baseSeconds: number;
  capSeconds: number;
  decaySeconds: number;
}

/** Counters that survive restarts and are shared by every server instance (Postgres in v1). */
export interface Throttle {
  /** Seconds the caller must wait because of any of these keys; 0 when none is locked. */
  retryAfter(keys: readonly string[]): Promise<number>;
  /** Counts one failure (for sign-up, one attempt) against a key. */
  fail(key: string, policy: ThrottlePolicy): Promise<void>;
  /** Forgets a key, after a successful login. */
  clear(key: string): Promise<void>;
}

export const POLICIES = {
  /** Per client IP: generous, because many people can share one address. */
  loginIp: { free: 20, baseSeconds: 5, capSeconds: 900, decaySeconds: 3600 },
  /** Per email, whether or not it exists: 5 free guesses, then 2 s, 4 s, ... up to 15 min. */
  loginAccount: { free: 5, baseSeconds: 2, capSeconds: 900, decaySeconds: 3600 },
  signUpIp: { free: 5, baseSeconds: 60, capSeconds: 3600, decaySeconds: 7200 },
  signUpAccount: { free: 3, baseSeconds: 60, capSeconds: 900, decaySeconds: 3600 },
} as const satisfies Record<string, ThrottlePolicy>;

export type Scope = "login" | "signup";

export const ipKey = (scope: Scope, ip: string): string => `${scope}-ip:${ip}`;

/** Keyed by a hash of the email, so the table never holds an address and an unknown email counts like a known one. */
export const accountKey = (scope: Scope, email: string): string =>
  `${scope}-acct:${createHash("sha256").update(email).digest("hex")}`;

/** The lock a key has after `failures` failures; the SQL function throttle_fail computes the same. */
export function lockSeconds(policy: ThrottlePolicy, failures: number): number {
  if (failures <= policy.free) return 0;
  return Math.min(
    policy.capSeconds,
    policy.baseSeconds * 2 ** Math.min(failures - policy.free - 1, 30),
  );
}
