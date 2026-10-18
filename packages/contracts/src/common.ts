import { z } from "zod";

export const Uuid = z.string().uuid();
export type Uuid = z.infer<typeof Uuid>;
export const IsoDateTime = z.string().datetime();
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** Opaque pagination cursor: the server issues it, clients echo it back unchanged. */
export const Cursor = z.string().min(1).max(512);
export type Cursor = z.infer<typeof Cursor>;

/** Body of every non-2xx response. */
export const ErrorBody = z.object({
  error: z.object({ code: z.string().min(1), message: z.string() }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;
