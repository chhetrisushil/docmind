import { z } from "zod";

export const Uuid = z.string().uuid();
export const IsoDateTime = z.string().datetime();

/** Opaque pagination cursor: the server issues it, clients echo it back unchanged. */
export const Cursor = z.string().min(1).max(512);

/** Body of every non-2xx response. */
export const ErrorBody = z.object({
  error: z.object({ code: z.string().min(1), message: z.string() }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;
