import { type KeyObject, createSecretKey } from "node:crypto";
import { readFileSync } from "node:fs";

/** A master key-encryption key. Data keys are stored wrapped by one; the id says which. */
export interface Kek {
  id: string;
  key: KeyObject;
}

const KEK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * The KEK from the environment: DOCMIND_KEK (base64) or DOCMIND_KEK_FILE (a file holding the base64),
 * named by DOCMIND_KEK_ID (default "kek-1"). A cloud KMS replaces this later, behind the same Kek.
 */
export function loadKek(env: NodeJS.ProcessEnv = process.env): Kek {
  const id = env.DOCMIND_KEK_ID ?? "kek-1";
  if (!KEK_ID.test(id)) throw new Error("DOCMIND_KEK_ID must match /^[a-z0-9][a-z0-9._-]{0,63}$/");
  const file = env.DOCMIND_KEK_FILE;
  if (env.DOCMIND_KEK && file)
    throw new Error("set one of DOCMIND_KEK or DOCMIND_KEK_FILE, not both");
  const name = file ? "DOCMIND_KEK_FILE" : "DOCMIND_KEK";
  const b64 = file ? readFileSync(file, "utf8").trim() : env.DOCMIND_KEK;
  if (!b64) throw new Error("set DOCMIND_KEK (base64, 32 bytes) or DOCMIND_KEK_FILE");
  const decoded = Buffer.from(b64, "base64");
  try {
    if (decoded.length !== 32 || decoded.toString("base64") !== b64) {
      throw new Error(`${name} must hold base64 of exactly 32 bytes`);
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
