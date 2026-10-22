import { StartupConfigError } from "../startupError";

/** Model ids: ollama tags ("gemma4:31b-cloud"), Claude and Gemini ids. Letters, digits and . _ : - only. */
const MODEL_ID = /^[a-z0-9][a-z0-9._:\-]{0,99}$/;

export const envModelId = (env: NodeJS.ProcessEnv, name: string, fallback: string): string => {
  const v = env[name]?.trim() || fallback;
  if (!MODEL_ID.test(v)) throw new StartupConfigError(`${name} must be a model id`);
  return v;
};
