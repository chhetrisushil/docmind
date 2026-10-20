import type { EventEnvelope } from "@loom/core";

const MIN_SECRET_CHARS = 12;
const isEnvelope = (v: unknown): boolean =>
  typeof v === "object" &&
  v !== null &&
  (v as { __loomEnc?: unknown }).__loomEnc === "loom/aes-256-gcm";

/**
 * Fails when any secret appears anywhere in the raw JSON of the events, keys and event types included.
 * The message says how many were found, never which. Secrets are distinctive texts of at least 12
 * characters (a shorter one proves nothing and can occur by chance).
 */
export function assertNoPlaintext(raw: readonly EventEnvelope[], secrets: readonly string[]): void {
  if (secrets.some((s) => s.length < MIN_SECRET_CHARS)) {
    throw new Error(`every secret must be at least ${MIN_SECRET_CHARS} characters`);
  }
  const json = JSON.stringify(raw);
  const leaked = secrets.filter((s) => json.includes(JSON.stringify(s).slice(1, -1)));
  if (leaked.length > 0)
    throw new Error(`a secret appears in the raw event log (${leaked.length} found)`);
}

/**
 * `<eventType>:<dotted path>` of every sealed envelope in the events, array indexes folded to `[]`.
 * Proves the sealing happened where it should (a scan alone passes on an empty or already-scrubbed log).
 */
export function sealedPaths(raw: readonly EventEnvelope[]): Set<string> {
  const found = new Set<string>();
  const walk = (type: string, value: unknown, path: string): void => {
    if (isEnvelope(value)) {
      found.add(`${type}:${path}`);
      return;
    }
    if (Array.isArray(value)) for (const item of value) walk(type, item, `${path}[]`);
    else if (typeof value === "object" && value !== null)
      for (const [k, v] of Object.entries(value)) walk(type, v, path === "" ? k : `${path}.${k}`);
  };
  for (const e of raw) walk(e.eventType, e.payload, "");
  return found;
}
