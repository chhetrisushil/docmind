import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP = resolve(__dirname);
// A call that starts or forks an execution. The runtime would otherwise mint a ULID, and the
// execution's data would fall outside the user's key (see subject.ts).
// Only the runtime's own start/fork: a method named `start` on some other object (the `IngestPort` in
// Task 54, whose single implementation sits in a file that also calls `executionIdFor(`) is not one.
const STARTS = /[Rr]untime\s*\.\s*(?:start|startExecution|fork)\s*\(/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    const isSource = path.endsWith(".ts") && !path.endsWith(".test.ts");
    return isSource && entry.name !== "loom.gen.ts" ? [path] : [];
  });
}

describe("execution ids", () => {
  it("the pattern recognises a start and a fork", () => {
    expect(STARTS.test("await runtime.start(def, { executionId })")).toBe(true);
    expect(STARTS.test("runtime\n  .fork(id, 3)")).toBe(true);
    expect(STARTS.test("server.listen(0)")).toBe(false);
    expect(STARTS.test("await deps.ingest.start(identity, documentId)")).toBe(false);
  });

  it("every source file that starts or forks an execution builds the id with executionIdFor", () => {
    const offenders = sources(APP)
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return STARTS.test(text) && !text.includes("executionIdFor(");
      })
      .map((file) => file.slice(APP.length + 1));
    expect(offenders).toEqual([]);
  });
});
