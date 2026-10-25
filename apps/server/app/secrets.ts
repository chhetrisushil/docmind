import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { StartupConfigError } from "./startupError";

/** The secrets that can come from a file (`<NAME>_FILE`), for a platform that mounts them rather than sets them. */
export const SECRET_VARIABLES = [
  "DATABASE_URL",
  "LOOM_DATABASE_URL",
  "DOCMIND_CHAT_ENVELOPE_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "DOCMIND_CHAT_ENVELOPE_KEY_PREVIOUS",
  // Read by the migration job and the KEK rotation script, which resolve them the same way.
  "DOCMIND_MIGRATE_URL",
  "DOCMIND_APP_DB_PASSWORD",
  "DOCMIND_LOOM_DB_PASSWORD",
] as const;

/** A secret is a connection string or a key; a file larger than this is a mistake (or a device). */
export const MAX_SECRET_FILE_BYTES = 64 * 1024;

/**
 * The file's text, or null when it is not a regular file of at most MAX_SECRET_FILE_BYTES. Opened
 * non-blocking so a FIFO cannot hang the boot, and checked after opening so a device such as /dev/zero
 * is refused before a byte is read.
 */
function readSmallFile(path: string): string | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_SECRET_FILE_BYTES) return null;
    const buf = Buffer.alloc(MAX_SECRET_FILE_BYTES + 1);
    let n = 0;
    for (let r = 1; r > 0 && n <= MAX_SECRET_FILE_BYTES; ) {
      r = readSync(fd, buf, n, buf.length - n, null);
      n += r;
    }
    return n > MAX_SECRET_FILE_BYTES ? null : buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * One secret: `<name>` or `<name>_FILE` (a file holding it), with the same rules as `DOCMIND_KEK_FILE`:
 * a non-empty `_FILE` wins over `<name>`, the content is trimmed, and a file that is empty after that
 * is an error. A read failure is a StartupConfigError that names the variable only: the driver's
 * message carries the path, and the content is never in an error.
 */
export function readSecret(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const fileVar = `${name}_FILE`;
  const path = env[fileVar];
  if (!path) return env[name];
  let raw: string | null;
  try {
    raw = readSmallFile(path);
  } catch {
    throw new StartupConfigError(`${fileVar} names a file that cannot be read`);
  }
  if (raw === null)
    throw new StartupConfigError(
      `${fileVar} must name a regular file of at most ${MAX_SECRET_FILE_BYTES} bytes`,
    );
  const content = raw.trim();
  if (!content) throw new StartupConfigError(`${fileVar} names an empty file`);
  return content;
}

/**
 * A copy of `env` with every secret in SECRET_VARIABLES resolved from its `_FILE`. Boot builds it once and
 * hands it to every loader that reads those names (chat settings, the LLM factory, the warnings), so
 * none of them needs to know about files and a bad file fails the boot before a connection opens.
 */
export function resolveSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of SECRET_VARIABLES) {
    const value = readSecret(env, name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}
