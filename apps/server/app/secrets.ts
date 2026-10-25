import { readFileSync } from "node:fs";
import { StartupConfigError } from "./startupError";

/** The secrets that can come from a file (`<NAME>_FILE`), for a platform that mounts them rather than sets them. */
export const SECRET_VARIABLES = [
  "DATABASE_URL",
  "LOOM_DATABASE_URL",
  "DOCMIND_CHAT_ENVELOPE_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
] as const;

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
  let content: string;
  try {
    content = readFileSync(path, "utf8").trim();
  } catch {
    throw new StartupConfigError(`${fileVar} names a file that cannot be read`);
  }
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
