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
  /** Counts the sessions this browser has held; a request remembers the one it was sent in. */
  private session = 0;
  private holds = 0;
  /** The session a real 401 arrived for while expiry was held; replayed on the last release if that session is still the current one. */
  private deferred: number | undefined;
  get epoch(): number {
    return this.session;
  }
  constructor(private readonly api: Pick<Api, "me" | "login" | "logout" | "signUp">) {
    super({ status: "unknown" });
  }
  /** Asks the server who this browser is. Any failure means anonymous: the sign-in screen is the safe place to land. */
  async bootstrap(): Promise<void> {
    try {
      const me = await this.api.me();
      this.session += 1;
      this.set({ status: "signed-in", me });
    } catch {
      this.signedOut();
    }
  }
  async login(req: LoginRequest): Promise<void> {
    const me = await this.api.login(req); // a refusal throws and leaves the state alone
    this.session += 1;
    this.set({ status: "signed-in", me });
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
  /** A 401 'unauthorized' came back from a call sent in session `epoch`: that session ended. A late answer for an older session is ignored. */
  expired(epoch?: number): void {
    if (epoch !== undefined && epoch !== this.session) return;
    if (this.holds > 0) {
      this.deferred = this.session;
      return;
    }
    this.signedOut();
  }
  /**
   * Runs `fn` with 401s from other calls not ending the session. A caller that will itself decide where a lost session goes
   * (the receipt page after a deletion) uses it so the route guard cannot send the browser to sign-in first.
   * Wrap only the single call whose 401 you handle: every other 401 that arrives meanwhile is held back too (and replayed on
   * the last release if the session is unchanged and signedOut was not called), so a wider wrap delays a real sign-out.
   */
  async withoutExpiry<T>(fn: () => Promise<T>): Promise<T> {
    this.holds += 1;
    try {
      return await fn();
    } finally {
      this.holds -= 1;
      if (this.holds === 0 && this.deferred !== undefined) {
        // A macrotask later: the caller's own handling of the 401 it saw (a navigation, signedOut) runs first, and a signedOut
        // changes the session, so the replay then finds nothing to do.
        setTimeout(() => {
          const epoch = this.deferred;
          this.deferred = undefined;
          if (this.holds === 0 && epoch !== undefined) this.expired(epoch);
        }, 0);
      }
    }
  }
  signedOut(): void {
    if (this.get().status === "anonymous") return;
    this.session += 1;
    this.set({ status: "anonymous" });
  }
}
