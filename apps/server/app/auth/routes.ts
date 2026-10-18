import {
  type AuthService,
  POLICIES,
  type Throttle,
  accountKey,
  clientIp,
  ipKey,
} from "@docmind/auth";
import { SignUpRequest, type SignUpResponse } from "@docmind/contracts";
import { readJson } from "../http/body";
import { type Handler, json, sendError } from "../http/respond";

export interface AuthRoutesDeps {
  service: AuthService;
  throttle: Throttle;
  /** Believe X-Forwarded-For (its last entry) for the client address. Only behind one proxy of yours. */
  trustProxy: boolean;
}

/** 429 with Retry-After. The body says nothing about whether the account exists. */
function tooMany(res: Parameters<Handler>[1], seconds: number): void {
  res.setHeader("retry-after", String(seconds));
  sendError(res, 429, "too_many_requests", "too many attempts; try again later");
}

/** Sign-up. (Login, logout and `GET /api/me` follow in the next PRs.) */
export function authRoutes(deps: AuthRoutesDeps): Record<string, Handler> {
  const { service, throttle, trustProxy } = deps;

  return {
    // Answers the same 202 whether or not the email is registered, and never sets a cookie, so the
    // response cannot tell the two apart; the client then logs in. Every attempt is counted.
    "POST /api/auth/sign-up": async (req, res) => {
      const body = await readJson(req, res, SignUpRequest);
      if (!body) return;
      const ip = ipKey("signup", clientIp(req, trustProxy));
      const account = accountKey("signup", body.email);
      const wait = await throttle.retryAfter([ip, account]);
      if (wait > 0) return tooMany(res, wait);
      await throttle.fail(ip, POLICIES.signUpIp);
      await throttle.fail(account, POLICIES.signUpAccount);
      await service.signUp(body.email, body.password);
      json(res, 202, { status: "accepted" } satisfies SignUpResponse);
    },
  };
}
