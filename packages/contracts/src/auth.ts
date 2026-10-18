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

/**
 * The only body sign-up ever answers with (202), whether or not the email was already registered:
 * it must not reveal which emails have accounts. The client then logs in.
 */
export const SignUpResponse = z.object({ status: z.literal("accepted") });
export type SignUpResponse = z.infer<typeof SignUpResponse>;

/** `GET /api/me`, and the body of a successful login. */
export const MeResponse = z.object({ userId: Uuid, tenantId: Uuid, email: Email });
export type MeResponse = z.infer<typeof MeResponse>;
