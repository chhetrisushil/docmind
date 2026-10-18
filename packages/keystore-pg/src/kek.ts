import { readFileSync } from "node:fs";

/** A master key-encryption key. Data keys are stored wrapped by one; the id says which. */
export interface Kek {
  id: string;
  key: Buffer;
}

/**
 * The KEK from the environment: DOCMIND_KEK (base64) or DOCMIND_KEK_FILE (a file holding the base64),
 * named by DOCMIND_KEK_ID (default "kek-1"). A cloud KMS replaces this later, behind the same Kek.
 */
export function loadKek(env: NodeJS.ProcessEnv = process.env): Kek {
  const file = env.DOCMIND_KEK_FILE;
  const b64 = file ? readFileSync(file, "utf8").trim() : env.DOCMIND_KEK;
  if (!b64) throw new Error("set DOCMIND_KEK (base64, 32 bytes) or DOCMIND_KEK_FILE");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error(`the KEK must be 32 bytes, got ${key.length}`);
  return { id: env.DOCMIND_KEK_ID ?? "kek-1", key };
}
