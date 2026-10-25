import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SECRET_VARIABLES, readSecret, resolveSecretEnv } from "./secrets";
import { StartupConfigError } from "./startupError";

const dir = mkdtempSync(join(tmpdir(), "docmind-secrets-"));
const file = (name: string, content: string): string => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

describe("readSecret", () => {
  it("returns the variable when no _FILE is set", () => {
    expect(readSecret({ DATABASE_URL: "postgres://a" }, "DATABASE_URL")).toBe("postgres://a");
  });

  it("returns undefined when neither is set", () => {
    expect(readSecret({}, "DATABASE_URL")).toBeUndefined();
  });

  it("reads the file and trims it, like DOCMIND_KEK_FILE", () => {
    const path = file("url", "  postgres://from-file\n");
    expect(readSecret({ DATABASE_URL_FILE: path }, "DATABASE_URL")).toBe("postgres://from-file");
  });

  it("lets the file win when both are set, like DOCMIND_KEK_FILE", () => {
    const path = file("both", "from-file\n");
    expect(readSecret({ DATABASE_URL: "from-env", DATABASE_URL_FILE: path }, "DATABASE_URL")).toBe(
      "from-file",
    );
  });

  it("ignores an empty _FILE variable", () => {
    expect(readSecret({ DATABASE_URL: "from-env", DATABASE_URL_FILE: "" }, "DATABASE_URL")).toBe(
      "from-env",
    );
  });

  it("refuses an empty file, naming the variable and not the path", () => {
    const path = file("empty", " \n");
    const err = catchError(() => readSecret({ DATABASE_URL_FILE: path }, "DATABASE_URL"));
    expect(err).toBeInstanceOf(StartupConfigError);
    expect((err as Error).message).toBe("DATABASE_URL_FILE names an empty file");
    expect((err as Error).message).not.toContain(path);
  });

  it("refuses an unreadable file, naming the variable and not the path", () => {
    const path = join(dir, "missing", "secret");
    const err = catchError(() => readSecret({ ANTHROPIC_API_KEY_FILE: path }, "ANTHROPIC_API_KEY"));
    expect(err).toBeInstanceOf(StartupConfigError);
    expect((err as Error).message).toBe("ANTHROPIC_API_KEY_FILE names a file that cannot be read");
    expect((err as Error).message).not.toContain(path);
  });
});

describe("resolveSecretEnv", () => {
  it("fills each secret from its file and leaves every other variable alone", () => {
    const env = {
      DATABASE_URL_FILE: file("a", "db\n"),
      LOOM_DATABASE_URL_FILE: file("b", "loom\n"),
      DOCMIND_CHAT_ENVELOPE_KEY_FILE: file("c", "envelope\n"),
      ANTHROPIC_API_KEY_FILE: file("d", "claude\n"),
      GEMINI_API_KEY_FILE: file("e", "gemini\n"),
      PORT: "3000",
    };
    const out = resolveSecretEnv(env);
    expect(out).toMatchObject({
      DATABASE_URL: "db",
      LOOM_DATABASE_URL: "loom",
      DOCMIND_CHAT_ENVELOPE_KEY: "envelope",
      ANTHROPIC_API_KEY: "claude",
      GEMINI_API_KEY: "gemini",
      PORT: "3000",
    });
    expect(SECRET_VARIABLES).toHaveLength(5);
  });

  it("does not change the env it was given, and sets nothing that has no value", () => {
    const env = { PORT: "3000" };
    const out = resolveSecretEnv(env);
    expect(out).toEqual({ PORT: "3000" });
    expect(out).not.toBe(env);
    expect("DATABASE_URL" in out).toBe(false);
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}
