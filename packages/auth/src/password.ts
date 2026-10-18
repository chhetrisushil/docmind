import argon2 from "argon2";

// OWASP's minimum argon2id profile: 19 MiB of memory, 2 passes, 1 lane.
const PARAMS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/** An argon2id hash in PHC string form; the salt and parameters are inside it. */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, PARAMS);
}

/** True only for a match. A malformed stored hash is a mismatch, not a crash. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let decoy: Promise<string> | undefined;

/**
 * Spends the time of a real check for an email that has no account, and discards the result. Without it,
 * a fast "no such user" answer tells an attacker which emails are registered.
 */
export async function verifyAgainstDecoy(password: string): Promise<void> {
  decoy ??= hashPassword("decoy-password-never-matches");
  await verifyPassword(await decoy, password);
}
