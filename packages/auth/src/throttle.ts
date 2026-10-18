import { createHash } from "node:crypto";
import { isIPv6 } from "node:net";

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
  /**
   * Counts one failure (for sign-up, one attempt) against a key. A failure made while the key
   * is locked still counts, and re-locks it from now with the next `lockSeconds` value.
   */
  fail(key: string, policy: ThrottlePolicy): Promise<void>;
  /**
   * Forgets the account key after a successful login. The IP key is never cleared on success,
   * so one good login cannot reset the guesses made from that address.
   */
  clear(key: string): Promise<void>;
}

export const POLICIES = {
  /** Per client IP: generous, because many people can share one address. */
  loginIp: { free: 20, baseSeconds: 5, capSeconds: 900, decaySeconds: 3600 },
  /** Per email, whether or not it exists: 5 free guesses, then 2 s, 4 s, ... up to 15 min. */
  loginAccount: { free: 5, baseSeconds: 2, capSeconds: 900, decaySeconds: 3600 },
  signUpIp: { free: 5, baseSeconds: 60, capSeconds: 3600, decaySeconds: 7200 },
  signUpAccount: { free: 3, baseSeconds: 60, capSeconds: 3600, decaySeconds: 7200 },
} as const satisfies Record<string, ThrottlePolicy>;

export type Scope = "login" | "signup";

export const ipKey = (scope: Scope, ip: string): string => `${scope}-ip:${throttleAddress(ip)}`;

/**
 * The address an IP key is built from. An IPv4-mapped IPv6 address becomes its IPv4. Any other
 * IPv6 address becomes its /64 prefix (first four hextets, lower-cased, e.g. `2001:db8:0:1::/64`),
 * because one host usually holds a whole /64; counting per full address would let an attacker
 * walk through it for free. IPv4 passes through unchanged.
 */
export function throttleAddress(ip: string): string {
  const a = ip.toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, "$1");
  if (!isIPv6(a)) return a;
  const bare = a.split("%")[0] ?? a;
  // A trailing dotted quad (::1.2.3.4) becomes two hextets before expansion.
  const m = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  const text = m
    ? `${m[1]}${((Number(m[2]) << 8) | Number(m[3])).toString(16)}:${((Number(m[4]) << 8) | Number(m[5])).toString(16)}`
    : bare;
  const [left = "", right] = text.split("::");
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  const groups =
    right === undefined
      ? leftGroups
      : [
          ...leftGroups,
          ...Array<string>(8 - leftGroups.length - rightGroups.length).fill("0"),
          ...rightGroups,
        ];
  const prefix = groups.slice(0, 4).map((g) => Number.parseInt(g, 16).toString(16));
  return `${prefix.join(":")}::/64`;
}

/** Keyed by a hash of the normalised email, so the table never holds an address and an unknown email counts like a known one. */
export const accountKey = (scope: Scope, email: string): string =>
  `${scope}-acct:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;

/**
 * The lock a key has after `failures` failures. The Postgres throttle (PR 6j) must compute the same.
 */
export function lockSeconds(policy: ThrottlePolicy, failures: number): number {
  if (failures <= policy.free) return 0;
  return Math.min(
    policy.capSeconds,
    policy.baseSeconds * 2 ** Math.min(failures - policy.free - 1, 30),
  );
}
