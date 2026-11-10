import { createHash } from "node:crypto";
import { z } from "zod";

// The keyset of the list order: created_at to the microsecond (UTC, exactly as Postgres formats
// it in repo.ts) and the id. Opaque to clients, but not trusted: it is validated like any input.
const Body = z
  .object({
    t: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
      // A real calendar instant: Postgres would reject 2026-13-45 and the request would 500.
      .refine((t) => {
        const ms = `${t.slice(0, 23)}Z`;
        const d = new Date(ms);
        // Year 0000 round-trips in JS but is not a Postgres timestamptz; 0001..9999 all are.
        return !t.startsWith("0000-") && !Number.isNaN(d.getTime()) && d.toISOString() === ms;
      }),
    i: z.string().uuid(),
    f: z
      .string()
      .regex(/^[0-9a-f]{16}$/)
      .optional(),
  })
  .strict();

/**
 * Names the filter a cursor was issued for: 16 hex characters of SHA-256 over `<match>|<sorted ids>`, `""` for no filter. A
 * cursor reused under another filter would skip or repeat rows, so the route refuses it. One tag is `any` whatever `match` says.
 */
export function filterFingerprint(
  filter: { tagIds: readonly string[]; match: "any" | "all" } | undefined,
): string {
  if (!filter || filter.tagIds.length === 0) return "";
  const ids = [...new Set(filter.tagIds.map((s) => s.toLowerCase()))].sort();
  const match = ids.length > 1 ? filter.match : "any";
  return createHash("sha256")
    .update(`${match}|${ids.join(",")}`)
    .digest("hex")
    .slice(0, 16);
}

export function encodeCursor(
  row: { created_cursor: string; id: string },
  fingerprint = "",
): string {
  return Buffer.from(
    JSON.stringify({
      t: row.created_cursor,
      i: row.id,
      ...(fingerprint !== "" && { f: fingerprint }),
    }),
  ).toString("base64url");
}

export function decodeCursor(cursor: string): { t: string; i: string; f?: string } | null {
  try {
    const parsed = Body.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
