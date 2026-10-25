import { StartupConfigError } from "./startupError";

export type Deployment = "development" | "production";

const blank = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

/**
 * `DOCMIND_DEPLOYMENT` (`development`, the default, or `production`). Production refuses to boot with a
 * setting that is fine on a laptop and wrong on a cloud host: no chat envelope key (a random one per
 * process makes queued chat envelopes fail after every restart), no public origin, a public origin that is not https, or cookies without
 * the Secure flag. A production boot without `DOCMIND_TRUST_PROXY=true` only warns. `env` is the secret-resolved env, so a key given as `_FILE` counts. The messages
 * name the variable and never a value.
 */
export function loadDeployment(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (m) => console.warn(m),
): Deployment {
  const mode = blank(env.DOCMIND_DEPLOYMENT) ?? "development";
  if (mode !== "development" && mode !== "production")
    throw new StartupConfigError("DOCMIND_DEPLOYMENT must be development or production");
  if (mode === "development") return mode;
  const need = (name: string) => {
    if (blank(env[name]) === undefined)
      throw new StartupConfigError(`${name} must be set when DOCMIND_DEPLOYMENT=production`);
  };
  need("DOCMIND_CHAT_ENVELOPE_KEY");
  need("DOCMIND_PUBLIC_ORIGIN");
  if (!blank(env.DOCMIND_PUBLIC_ORIGIN)?.startsWith("https://"))
    throw new StartupConfigError(
      "DOCMIND_PUBLIC_ORIGIN must be an https:// origin when DOCMIND_DEPLOYMENT=production",
    );
  if (env.DOCMIND_COOKIE_SECURE !== "true")
    throw new StartupConfigError(
      "DOCMIND_COOKIE_SECURE must be true when DOCMIND_DEPLOYMENT=production",
    );
  // Not fatal (a single proxy-less host is legitimate), but behind a balancer it is a silent mistake.
  if (env.DOCMIND_TRUST_PROXY !== "true")
    warn(
      "DOCMIND_TRUST_PROXY is not true: behind a load balancer every client shares one login and sign-up throttle key",
    );
  return mode;
}
