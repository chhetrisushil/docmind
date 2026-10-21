import { createHash, randomBytes } from "node:crypto";

/** The sha256 of the token's text. This, never the token, is what the database holds and what the status route looks up. */
export const hashReceipt = (token: string): Buffer =>
  createHash("sha256").update(token, "utf8").digest();

/** A fresh receipt: 32 random bytes as base64url (43 characters), and its hash. The token is shown to the caller once. */
export function newReceipt(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashReceipt(token) };
}
