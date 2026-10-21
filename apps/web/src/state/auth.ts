import type { LoginRequest, MeResponse, SignUpRequest } from "@docmind/contracts";
import type { Api } from "../api/client";
import { ApiError } from "../api/http";
import { Store } from "./store";

export type AuthState =
  | { status: "unknown" }
  | { status: "anonymous" }
  | { status: "signed-in"; me: MeResponse };

/** Fixed sentences by status and code. The server's own message is never shown: it could echo what was typed. */
export function authErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return "Could not reach the server. Check your connection.";
    if (err.status === 401) return "The email or password is not right.";
    if (err.status === 429)
      return err.retryAfter !== undefined
        ? `Too many attempts. Try again in ${err.retryAfter} seconds.`
        : "Too many attempts. Try again in a minute.";
    if (err.status === 400) return "Check the email and password and try again.";
  }
  return "Something went wrong. Try again.";
}

export class AuthStore extends Store<AuthState> {
  constructor(private readonly api: Pick<Api, "me" | "login" | "logout" | "signUp">) {
    super({ status: "unknown" });
  }
  /** Asks the server who this browser is. Any failure means anonymous: the sign-in screen is the safe place to land. */
  async bootstrap(): Promise<void> {
    try {
      this.set({ status: "signed-in", me: await this.api.me() });
    } catch {
      this.signedOut();
    }
  }
  async login(req: LoginRequest): Promise<void> {
    this.set({ status: "signed-in", me: await this.api.login(req) }); // a refusal throws and leaves the state alone
  }
  /** Sign-up answers 202 whether or not the address exists, so the account is only known to work once the sign-in succeeds. */
  async signUp(req: SignUpRequest): Promise<void> {
    await this.api.signUp(req);
    await this.login({ email: req.email, password: req.password });
  }
  async logout(): Promise<void> {
    try {
      await this.api.logout();
    } catch {
      // the cookie may still be valid, but this browser is done: the sign-in screen, and a later 401 if it was not cleared
    }
    this.signedOut();
  }
  /** A 401 'unauthorized' came back from any call: the session ended. */
  expired(): void {
    this.signedOut();
  }
  signedOut(): void {
    if (this.get().status === "anonymous") return;
    this.set({ status: "anonymous" });
  }
}
