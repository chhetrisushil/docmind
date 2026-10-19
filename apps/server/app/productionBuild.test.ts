import { dirname } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Modules that exist only for tests: fixtures, fakes, harnesses and the throwaway-database support. */
const TEST_ONLY =
  /(\.test|\/testing|\/testSupport|\/testHarness|Harness|\/pgFixture|\/ingestStack)\.ts$/;

describe("the production build", () => {
  it("compiles no test-only module, so production code imports none", () => {
    const path = ts.findConfigFile(__dirname, ts.sys.fileExists, "tsconfig.json") as string;
    const config = ts.getParsedCommandLineOfConfigFile(
      path,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: () => {
          throw new Error("tsconfig.json is unreadable");
        },
      },
    );
    const program = ts.createProgram({
      rootNames: config?.fileNames ?? [],
      options: config?.options ?? {},
    });
    const root = dirname(path);
    const files = program
      .getSourceFiles()
      .map((f) => f.fileName)
      .filter((f) => f.startsWith(`${root}/`) && !f.endsWith(".d.ts"));
    expect(files.length).toBeGreaterThan(10); // the program is the real one, not an empty one
    // A file here is a production file, or a test-only one a production file imports (tsc pulls
    // imports in even when excluded).
    expect(files.filter((f) => TEST_ONLY.test(f))).toEqual([]);
  });
});
