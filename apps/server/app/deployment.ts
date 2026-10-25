import { StartupConfigError } from "./startupError";

export type Deployment = "development" | "production";

const blank = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

/**
 * `DOCMIND_DEPLOYMENT` (`development`, the default, or `production`). Production refuses to boot with a
 * setting that is fine on a laptop and wrong on a cloud host: no chat envelope key (a random one per
 * process makes queued chat envelopes fail after every restart), no public origin, or cookies without
 * the Secure flag. `env` is the secret-resolved env, so a key given as `_FILE` counts. The messages
 * name the variable and never a value.
 */
export function loadDeployment(env: NodeJS.ProcessEnv = process.env): Deployment {
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
  if (env.DOCMIND_COOKIE_SECURE !== "true")
    throw new StartupConfigError(
      "DOCMIND_COOKIE_SECURE must be true when DOCMIND_DEPLOYMENT=production",
    );
  return mode;
}
