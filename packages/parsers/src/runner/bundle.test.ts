import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ParseRunner } from "./ParseRunner";

const BUNDLE = join(__dirname, "../../dist/child/child.cjs");
const LIMITS = { wallClockMs: 10_000, memoryMb: 256, maxInputBytes: 1 << 20, maxChars: 1 << 20 };

describe("the parse child bundle", () => {
  it("exists after build and requires nothing but Node builtins (the parserModule seam aside)", () => {
    expect(existsSync(BUNDLE)).toBe(true);
    const source = readFileSync(BUNDLE, "utf8");
    const required = [...source.matchAll(/\brequire\("([^"]+)"\)/g)].map((m) => m[1] as string);
    const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
    expect(required.filter((r) => !builtins.has(r))).toEqual([]);
  });

  it("parses through the bundle with read access to its own directory only", async () => {
    const runner = new ParseRunner({ limits: LIMITS });
    try {
      const doc = await runner.run("txt", new TextEncoder().encode("hello bundle\n"));
      expect(doc.text).toBe("hello bundle\n");
    } finally {
      await runner.close();
    }
  });
});
