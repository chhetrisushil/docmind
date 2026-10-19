import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawned: ChildProcess[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    fork: ((...args: Parameters<typeof actual.fork>) => {
      const child = actual.fork(...args);
      spawned.push(child);
      return child;
    }) as typeof actual.fork,
  };
});

import { ParseCrashedError, ParseRunner } from "./ParseRunner";

const LIMITS = { wallClockMs: 10_000, memoryMb: 256 };
const hostile = resolve(__dirname, "../../test-fixtures/hostile.cjs");
const runner = (parserModule: string | null = hostile) =>
  new ParseRunner({ limits: LIMITS, ...(parserModule ? { parserModule } : {}) });
const bytes = (s: string) => new TextEncoder().encode(s);
const released = () => {
  expect(spawned).toHaveLength(1);
  expect(spawned[0]?.exitCode !== null || spawned[0]?.signalCode !== null).toBe(true);
};

describe("ParseRunner", () => {
  beforeEach(() => {
    spawned.length = 0;
  });

  it("runs the real txt parser in a child and returns a validated document", async () => {
    const doc = await runner(null).run("txt", bytes("hello\nworld"));
    expect(doc.text).toBe("hello\nworld");
    expect(doc.sections).toHaveLength(1);
    released();
  });

  it("runs a test-module parser and returns its text", async () => {
    expect((await runner().run("echo", bytes("echoed"))).text).toBe("echoed");
    released();
  });

  it("maps a parser's rejection to ParseRejectedError with its code", async () => {
    const run = runner(null).run("txt", Uint8Array.from([0x41, 0, 0x42]));
    await expect(run).rejects.toMatchObject({
      name: "ParseRejectedError",
      code: "unsupported_content",
    });
    released();
  });

  it("maps an unknown parser id to a fixed crash error", async () => {
    await expect(runner().run("nope", bytes("x"))).rejects.toBeInstanceOf(ParseCrashedError);
    released();
  });

  it("never carries a thrown message: parse() throwing becomes a fixed crash", async () => {
    const run = runner().run("throws-parse", bytes("x"));
    await expect(run).rejects.toMatchObject({
      name: "ParseCrashedError",
      message: "parse crashed",
    });
    released();
  });

  it("does not call accepts() in the child: a throwing accepts() cannot crash a run", async () => {
    expect((await runner().run("throws-accepts", bytes("x"))).text).toBe("fine");
    released();
  });

  it("rejects a reply that fails ParsedDocument validation", async () => {
    const run = runner().run("bad-shape", bytes("x"));
    await expect(run).rejects.toMatchObject({
      name: "ParseCrashedError",
      message: "parse crashed",
    });
    released();
  });
});
