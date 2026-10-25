import { describe, expect, it, vi } from "vitest";
import { loadDeployment } from "./deployment";
import { StartupConfigError } from "./startupError";

const PROD_OK: NodeJS.ProcessEnv = {
  DOCMIND_DEPLOYMENT: "production",
  DOCMIND_CHAT_ENVELOPE_KEY: "k".repeat(32),
  DOCMIND_PUBLIC_ORIGIN: "https://docmind.example.com",
  DOCMIND_COOKIE_SECURE: "true",
};

describe("loadDeployment", () => {
  it("defaults to development and asks for nothing", () => {
    expect(loadDeployment({})).toBe("development");
    expect(loadDeployment({ DOCMIND_DEPLOYMENT: "development" })).toBe("development");
    expect(loadDeployment({ DOCMIND_DEPLOYMENT: "  " })).toBe("development");
  });

  it("accepts a complete production configuration", () => {
    expect(loadDeployment({ ...PROD_OK, DOCMIND_TRUST_PROXY: "true" })).toBe("production");
  });

  it.each(["prod", "Production", "staging", "1"])("refuses %s, naming the variable only", (bad) => {
    expect(() => loadDeployment({ DOCMIND_DEPLOYMENT: bad })).toThrow(
      new StartupConfigError("DOCMIND_DEPLOYMENT must be development or production"),
    );
  });

  it.each([
    ["DOCMIND_CHAT_ENVELOPE_KEY", undefined],
    ["DOCMIND_CHAT_ENVELOPE_KEY", "   "],
    ["DOCMIND_PUBLIC_ORIGIN", undefined],
    ["DOCMIND_PUBLIC_ORIGIN", ""],
    ["DOCMIND_COOKIE_SECURE", undefined],
    ["DOCMIND_COOKIE_SECURE", "false"],
    ["DOCMIND_COOKIE_SECURE", "1"],
  ])("refuses production with %s = %s", (name, value) => {
    const env: NodeJS.ProcessEnv = { ...PROD_OK };
    if (value === undefined) delete env[name];
    else env[name] = value;
    expect(() => loadDeployment(env)).toThrow(StartupConfigError);
    expect(() => loadDeployment(env)).toThrow(new RegExp(`^${name} `));
  });

  it.each(["http://docmind.example.com", "ftp://x.example", "docmind.example.com"])(
    "refuses a production origin that is not https (%s)",
    (origin) => {
      expect(() => loadDeployment({ ...PROD_OK, DOCMIND_PUBLIC_ORIGIN: origin })).toThrow(
        new StartupConfigError(
          "DOCMIND_PUBLIC_ORIGIN must be an https:// origin when DOCMIND_DEPLOYMENT=production",
        ),
      );
    },
  );

  it("allows an http origin in development", () => {
    expect(loadDeployment({ DOCMIND_PUBLIC_ORIGIN: "http://localhost:3000" })).toBe("development");
  });

  it("warns, with fixed text, when production does not trust the proxy; and only then", () => {
    const warn = vi.fn();
    loadDeployment(PROD_OK, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe(
      "DOCMIND_TRUST_PROXY is not true: behind a load balancer every client shares one login and sign-up throttle key",
    );
    warn.mockClear();
    loadDeployment({ ...PROD_OK, DOCMIND_TRUST_PROXY: "true" }, warn);
    loadDeployment({}, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it("never puts a value in the message", () => {
    const env = { ...PROD_OK, DOCMIND_COOKIE_SECURE: "not-a-secret-value" };
    expect(() => loadDeployment(env)).toThrow(
      new StartupConfigError(
        "DOCMIND_COOKIE_SECURE must be true when DOCMIND_DEPLOYMENT=production",
      ),
    );
  });
});
