import {
  type AuthService,
  type AuthStore,
  type Authenticator,
  POLICIES,
  SESSION_TTL_MS,
  type Throttle,
  accountKey,
  clearedSessionCookie,
  clientIp,
  ipKey,
  readSessionCookie,
  sessionCookie,
} from "@docmind/auth";
import {
  DeleteAccountRequest,
  type DeleteAccountResponse,
  ErasureReceipt,
  type ErasureStatusResponse,
  LoginRequest,
  type MeResponse,
  SignUpRequest,
  type SignUpResponse,
} from "@docmind/contracts";
import type { AccountErasure } from "../erasure/account";
import { hashReceipt, newReceipt } from "../erasure/receipt";
import { readJson } from "../http/body";
import { requireAuth } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";

export interface AuthRoutesDeps {
  service: AuthService;
  authenticator: Authenticator;
  store: AuthStore;
  throttle: Throttle;
  /** Mark the session cookie Secure: set it for any deployment served over HTTPS. */
  secureCookies: boolean;
  /** Believe X-Forwarded-For for the client address (the entry `trustProxyHops` from the right). Only behind proxies of yours. */
  trustProxy: boolean;
  /** Trusted proxies in front of the server (`DOCMIND_TRUST_PROXY_HOPS`); only read with `trustProxy`. Default 1. */
  trustProxyHops?: number;
  /** Absent: `DELETE /api/me` is not a route. */
  erasure?: AccountErasure;
}

/** 429 with Retry-After. The body says nothing about whether the account exists. */
function tooMany(res: Parameters<Handler>[1], seconds: number): void {
  res.setHeader("retry-after", String(seconds));
  sendError(res, 429, "too_many_requests", "too many attempts; try again later");
}

/** Sign-up, login, logout and `GET /api/me`. Every route gets its identity from the session. */
export function authRoutes(deps: AuthRoutesDeps): Record<string, Handler> {
  const {
    service,
    authenticator,
    store,
    throttle,
    secureCookies,
    trustProxy,
    trustProxyHops,
    erasure,
  } = deps;

  return {
    // Answers the same 202 whether or not the email is registered, and never sets a cookie, so the
    // response cannot tell the two apart; the client then logs in. Every attempt is counted first.
    "POST /api/auth/sign-up": async (req, res) => {
      const body = await readJson(req, res, SignUpRequest);
      if (!body) return;
      const ip = ipKey("signup", clientIp(req, trustProxy, trustProxyHops));
      const account = accountKey("signup", body.email);
      // Count, then check (before any argon2): a check-then-count lets a parallel burst all pass.
      await throttle.fail(ip, POLICIES.signUpIp);
      await throttle.fail(account, POLICIES.signUpAccount);
      const wait = await throttle.retryAfter([ip, account]);
      if (wait > 0) return tooMany(res, wait);
      await service.signUp(body.email, body.password);
      json(res, 202, { status: "accepted" } satisfies SignUpResponse);
    },

    // Every attempt is counted against the email (known or not) before the password is checked, so
    // a parallel burst cannot all get a guess. Only a failure counts against the address, and a
    // success forgets the email's count, never the address's. A locked caller learns nothing.
    "POST /api/auth/login": async (req, res) => {
      const body = await readJson(req, res, LoginRequest);
      if (!body) return;
      const ip = ipKey("login", clientIp(req, trustProxy, trustProxyHops));
      const account = accountKey("login", body.email);
      await throttle.fail(account, POLICIES.loginAccount);
      const wait = await throttle.retryAfter([ip, account]);
      if (wait > 0) return tooMany(res, wait);
      const started = await service.logIn(body.email, body.password);
      if (!started) {
        await throttle.fail(ip, POLICIES.loginIp);
        return sendError(res, 401, "invalid_credentials", "email or password is incorrect");
      }
      await throttle.clear(account);
      res.setHeader("set-cookie", sessionCookie(started.token, SESSION_TTL_MS, secureCookies));
      json(res, 200, { ...started.identity, email: body.email } satisfies MeResponse);
    },

    // Always clears the cookie, even for a request with no live session: logging out twice is fine.
    "POST /api/auth/logout": async (req, res) => {
      const token = readSessionCookie(req.headers);
      const identity = await authenticator.authenticate(req);
      if (token && identity) await service.logOut(identity, token);
      res.setHeader("set-cookie", clearedSessionCookie(secureCookies));
      res.writeHead(204);
      res.end();
    },

    "GET /api/me": requireAuth(authenticator, async (_req, res, identity) => {
      const email = await store.findEmail(identity);
      if (!email) return sendError(res, 401, "unauthorized", "authentication required");
      json(res, 200, { ...identity, email } satisfies MeResponse);
    }),

    // The password again (a stolen session alone must not erase an account), under the login throttle: the
    // same account and address counters, so guesses here and at login draw from one budget. The request, the
    // session wipe, `erasing_at` and the email scrub are one transaction; the erasure itself runs in the
    // background, and only after that transaction has committed. The answer carries the receipt (shown once;
    // only its hash is stored). The user is always the session's own, never anything from the body.
    ...(erasure && {
      "DELETE /api/me": requireAuth(authenticator, async (req, res, identity) => {
        const body = await readJson(req, res, DeleteAccountRequest);
        if (!body) return;
        const email = await store.findEmail(identity);
        if (!email) return sendError(res, 401, "unauthorized", "authentication required");
        const ip = ipKey("login", clientIp(req, trustProxy, trustProxyHops));
        const account = accountKey("login", email);
        await throttle.fail(account, POLICIES.loginAccount);
        const wait = await throttle.retryAfter([ip, account]);
        if (wait > 0) return tooMany(res, wait);
        if (!(await service.confirmPassword(identity, email, body.password))) {
          await throttle.fail(ip, POLICIES.loginIp);
          return sendError(res, 401, "invalid_credentials", "password is incorrect");
        }
        await throttle.clear(account);
        // The counters are keyed by a hash of the email, which the request below replaces: clear the sign-up
        // counter now, while the email is known (the eraser's `rows` step cannot read it any more).
        await throttle.clear(accountKey("signup", email));
        const receipt = newReceipt();
        res.setHeader("cache-control", "no-store");
        if (!(await erasure.request(identity, receipt.hash)))
          return sendError(res, 409, "erasure_in_progress", "an erasure is already in progress");
        res.setHeader("set-cookie", clearedSessionCookie(secureCookies));
        json(res, 202, {
          erasure: "accepted",
          receipt: receipt.token,
        } satisfies DeleteAccountResponse);
        erasure.start(identity.userId);
      }),

      // No session: the receipt is the credential (256 random bits), and the answer is a state and nothing else.
      // Every request is counted per client address first (the sign-up pattern: count, then check), so a flood
      // is slowed whether it sends real tokens, unknown ones or garbage. A malformed token never reaches the
      // database, and looks exactly like an unknown one. Nothing about the answer is cacheable.
      "GET /api/erasure/:receipt": async (req, res, { params }) => {
        res.setHeader("cache-control", "no-store");
        const ip = ipKey("erasure", clientIp(req, trustProxy, trustProxyHops));
        await throttle.fail(ip, POLICIES.erasureStatusIp);
        const wait = await throttle.retryAfter([ip]);
        if (wait > 0) return tooMany(res, wait);
        const receipt = ErasureReceipt.safeParse(params.receipt);
        const state = receipt.success ? await erasure.status(hashReceipt(receipt.data)) : null;
        if (!state) return sendError(res, 404, "not_found", "no such erasure");
        json(res, 200, { state } satisfies ErasureStatusResponse);
      },
    }),
  };
}
