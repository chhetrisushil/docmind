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
  })
  .strict();

export function encodeCursor(row: { created_cursor: string; id: string }): string {
  return Buffer.from(JSON.stringify({ t: row.created_cursor, i: row.id })).toString("base64url");
}

export function decodeCursor(cursor: string): { t: string; i: string } | null {
  try {
    const parsed = Body.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
