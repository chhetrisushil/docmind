import { z } from "zod";
import { Uuid } from "./common";

/** Trimmed and lower-cased on the way in, so `users.email UNIQUE` is case-insensitive. */
export const Email = z.string().trim().toLowerCase().email().max(254);
export type Email = z.infer<typeof Email>;

export const SignUpRequest = z.object({
  email: Email,
  password: z.string().min(12).max(128),
});
export type SignUpRequest = z.infer<typeof SignUpRequest>;

/** No minimum length on login: a password set under an older policy must still work. */
export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** `GET /api/me`, and the body of a successful sign-up or login. */
export const MeResponse = z.object({ userId: Uuid, tenantId: Uuid, email: Email });
export type MeResponse = z.infer<typeof MeResponse>;
