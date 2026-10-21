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

/** `DELETE /api/me`: the account's own password, so a stolen session alone cannot erase it. No minimum, like login. */
export const DeleteAccountRequest = z.object({ password: z.string().min(1).max(128) });
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequest>;

/** An erasure receipt: 32 random bytes as base64url, which is 43 characters (no padding). The caller's only handle once the session is gone. */
export const ErasureReceipt = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export type ErasureReceipt = z.infer<typeof ErasureReceipt>;

/**
 * The only success answer (202). The erasure runs in the background: it can wait for a chat turn that is
 * still running, and it resumes after a restart. `receipt` is shown once; `GET /api/erasure/:receipt` reads it.
 */
export const DeleteAccountResponse = z.object({
  erasure: z.literal("accepted"),
  receipt: ErasureReceipt,
});
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponse>;

/** The 409 of `DELETE /api/me` when an erasure of the account is already recorded (two overlapping requests); it carries no receipt. */
export const ErasureInProgressBody = z.object({
  error: z.object({ code: z.literal("erasure_in_progress"), message: z.string() }),
});
export type ErasureInProgressBody = z.infer<typeof ErasureInProgressBody>;
