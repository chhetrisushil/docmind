import { positiveInt } from "../documents/limits";
import { StartupConfigError } from "../startupError";

/** More proxies than this in front of one server is a typo, not a topology. */
const MAX_HOPS = 32;

/**
 * `DOCMIND_TRUST_PROXY` (exactly "true" to believe X-Forwarded-For) and `DOCMIND_TRUST_PROXY_HOPS`, the
 * number of proxies of yours between the client and this server (default 1). The client address is the
 * entry that many places from the right of the header (see `clientIp`). A hop count without the trust
 * switch is a mistake, not a no-op: it would read as protection that is not there, so it fails the boot.
 */
export function loadTrustProxy(env: NodeJS.ProcessEnv = process.env): {
  trustProxy: boolean;
  hops: number;
} {
  const trustProxy = env.DOCMIND_TRUST_PROXY === "true";
  if (!trustProxy && env.DOCMIND_TRUST_PROXY_HOPS?.trim())
    throw new StartupConfigError("DOCMIND_TRUST_PROXY_HOPS needs DOCMIND_TRUST_PROXY=true");
  return { trustProxy, hops: positiveInt(env, "DOCMIND_TRUST_PROXY_HOPS", 1, MAX_HOPS) };
}
