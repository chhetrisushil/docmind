import argon2 from "argon2";

// OWASP's minimum argon2id profile: 19 MiB of memory, 2 passes, 1 lane.
const PARAMS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/** An argon2id hash in PHC string form; the salt and parameters are inside it. */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, PARAMS);
}

/**
 * True only for a match. Any failure is a mismatch, not a crash, but it is logged (error name and
 * code only, never the hash or password) so a broken argon2 binding cannot turn every login into a
 * silent 401. The library's errors for a malformed hash are not reliably told apart from a broken
 * binding, so all of them are logged.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch (err) {
    const e = err as { name?: unknown; code?: unknown };
    console.error("argon2 verify failed:", String(e?.name ?? "unknown"), String(e?.code ?? ""));
    return false;
  }
}

let decoy: Promise<string> | undefined;

/** Computes the decoy hash once. A failed computation is forgotten so the next call retries it. */
function getDecoy(): Promise<string> {
  decoy ??= hashPassword("decoy-password-never-matches").catch((error: unknown) => {
    decoy = undefined;
    throw error;
  });
  return decoy;
}

/** Computes the decoy hash ahead of the first unknown-email check. Never throws; a failure is retried later. */
export async function primeDecoy(): Promise<void> {
  try {
    await getDecoy();
  } catch {
    // Retried by the next verifyAgainstDecoy or primeDecoy call.
  }
}

/**
 * Spends the time of a real check for an email that has no account, and discards the result. Without it,
 * a fast "no such user" answer tells an attacker which emails are registered. Never throws: a throw here
 * would answer differently from a wrong password and reveal the same thing.
 */
export async function verifyAgainstDecoy(password: string): Promise<void> {
  try {
    await verifyPassword(await getDecoy(), password);
  } catch {
    // The decoy could not be computed; the check still answered "no", so the caller's 401 stands.
  }
}
