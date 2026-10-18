import { type KeyObject, createSecretKey } from "node:crypto";
import { readFileSync } from "node:fs";

/** A master key-encryption key. Data keys are stored wrapped by one; the id says which. */
export interface Kek {
  id: string;
  key: KeyObject;
}

const KEK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * One KEK from the environment: `<name>` (base64) or `<name>_FILE` (a file holding the base64),
 * named by `<name>_ID`. Only DOCMIND_KEK defaults its id (to "kek-1"). A cloud KMS replaces this
 * later, behind the same Kek.
 */
export function loadKek(
  env: NodeJS.ProcessEnv = process.env,
  name = "DOCMIND_KEK",
  defaultId = name === "DOCMIND_KEK" ? "kek-1" : undefined,
): Kek {
  const idVar = `${name}_ID`;
  const id = env[idVar] ?? defaultId;
  if (!id) throw new Error(`set ${idVar}, the name that tells this key from the others`);
  if (!KEK_ID.test(id)) throw new Error(`${idVar} must match /^[a-z0-9][a-z0-9._-]{0,63}$/`);
  const file = env[`${name}_FILE`];
  const varName = file ? `${name}_FILE` : name;
  const b64 = file ? readFileSync(file, "utf8").trim() : env[name];
  if (!b64) throw new Error(`set ${name} (base64, 32 bytes) or ${name}_FILE`);
  const decoded = Buffer.from(b64, "base64");
  try {
    if (decoded.length !== 32 || decoded.toString("base64") !== b64) {
      throw new Error(`${varName} must hold base64 of exactly 32 bytes`);
    }
    const key = Buffer.alloc(32);
    decoded.copy(key);
    const kek = { id, key: createSecretKey(key) };
    key.fill(0);
    return kek;
  } finally {
    decoded.fill(0);
  }
}

/**
 * The KEKs this server runs with: the current one (`DOCMIND_KEK`, id default "kek-1") first, which
 * wraps new keys, and while a rotation is under way the one being retired (`DOCMIND_KEK_PREVIOUS`,
 * its id required), which can still open keys not yet re-wrapped.
 */
export function loadKeks(env: NodeJS.ProcessEnv = process.env): readonly [Kek, ...Kek[]] {
  const current = loadKek(env);
  if (!env.DOCMIND_KEK_PREVIOUS && !env.DOCMIND_KEK_PREVIOUS_FILE) return [current];
  const previous = loadKek(env, "DOCMIND_KEK_PREVIOUS");
  if (previous.id === current.id) throw new Error("the previous KEK must have a different id");
  return [current, previous];
}
