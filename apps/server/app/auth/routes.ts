import {
  type AuthService,
  POLICIES,
  SESSION_TTL_MS,
  type Throttle,
  accountKey,
  clientIp,
  ipKey,
  sessionCookie,
} from "@docmind/auth";
import {
  LoginRequest,
  type MeResponse,
  SignUpRequest,
  type SignUpResponse,
} from "@docmind/contracts";
import { readJson } from "../http/body";
import { type Handler, json, sendError } from "../http/respond";

export interface AuthRoutesDeps {
  service: AuthService;
  throttle: Throttle;
  /** Mark the session cookie Secure: set it for any deployment served over HTTPS. */
  secureCookies: boolean;
  /** Believe X-Forwarded-For (its last entry) for the client address. Only behind one proxy of yours. */
  trustProxy: boolean;
}

/** 429 with Retry-After. The body says nothing about whether the account exists. */
function tooMany(res: Parameters<Handler>[1], seconds: number): void {
  res.setHeader("retry-after", String(seconds));
  sendError(res, 429, "too_many_requests", "too many attempts; try again later");
}

/** Sign-up and login. (Logout and `GET /api/me` follow in the next PR.) */
export function authRoutes(deps: AuthRoutesDeps): Record<string, Handler> {
  const { service, throttle, secureCookies, trustProxy } = deps;

  return {
    // Answers the same 202 whether or not the email is registered, and never sets a cookie, so the
    // response cannot tell the two apart; the client then logs in. Every attempt is counted first.
    "POST /api/auth/sign-up": async (req, res) => {
      const body = await readJson(req, res, SignUpRequest);
      if (!body) return;
      const ip = ipKey("signup", clientIp(req, trustProxy));
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
      const ip = ipKey("login", clientIp(req, trustProxy));
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
  };
}
