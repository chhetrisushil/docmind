import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartupConfigError } from "./startupError";

const createAppPool = vi.fn();
vi.mock("./db/pool", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db/pool")>()),
  createAppPool: (...args: unknown[]) => createAppPool(...args),
}));

import { setupServer } from "./setup";

const saved = { ...process.env };
beforeEach(() => {
  // Hermetic: whatever the developer's shell or .env set must not decide these tests.
  for (const key of Object.keys(process.env))
    if (/^(DOCMIND_|DATABASE_URL|LOOM_DATABASE_URL|ANTHROPIC_|GEMINI_|HOST$|PORT$)/.test(key))
      Reflect.deleteProperty(process.env, key);
  createAppPool.mockReset();
  createAppPool.mockRejectedValue(new Error("a pool was opened"));
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("setupServer configuration", () => {
  it("refuses a production boot that lacks a required setting before any pool opens", async () => {
    process.env.DOCMIND_DEPLOYMENT = "production";
    process.env.DOCMIND_CHAT_ENVELOPE_KEY = "";
    Reflect.deleteProperty(process.env, "DOCMIND_CHAT_ENVELOPE_KEY_FILE");
    await expect(setupServer()).rejects.toThrow(
      new StartupConfigError(
        "DOCMIND_CHAT_ENVELOPE_KEY must be set when DOCMIND_DEPLOYMENT=production",
      ),
    );
    expect(createAppPool).not.toHaveBeenCalled();
  });

  it("resolves a _FILE secret first, so a bad file fails the boot before any pool opens", async () => {
    process.env.DATABASE_URL_FILE = join(tmpdir(), "docmind-no-such-secret-file");
    await expect(setupServer()).rejects.toThrow(
      new StartupConfigError("DATABASE_URL_FILE names a file that cannot be read"),
    );
    expect(createAppPool).not.toHaveBeenCalled();
  });

  it("takes DATABASE_URL from its file: the pool is opened with the file's content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "docmind-setup-"));
    writeFileSync(join(dir, "db"), "postgres://from-file/db\n");
    process.env.DATABASE_URL_FILE = join(dir, "db");
    process.env.DATABASE_URL = "postgres://from-env/db";
    process.env.LOOM_DATABASE_URL = "postgres://loom/db";
    process.env.PORT = "0";
    process.env.DOCMIND_KEK = Buffer.alloc(32, 7).toString("base64");
    process.env.DOCMIND_LLM_PROVIDER = "off";
    process.env.DOCMIND_DEPLOYMENT = "development";
    await expect(setupServer()).rejects.toThrow("a pool was opened");
    expect(createAppPool.mock.calls[0]?.[0]).toBe("postgres://from-file/db");
  });
});
