import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const req = createRequire(__filename);

describe("@docmind/parsers exports map", () => {
  it("resolves the package entry", () => {
    expect(req.resolve("@docmind/parsers")).toMatch(/dist[\\/]index\.js$/);
  });
  it.each(["runner/ParseRunner.js", "runner/internals.js", "runner/child.js"])(
    "refuses the deep import dist/%s",
    (file) => {
      expect(() => req.resolve(`@docmind/parsers/dist/${file}`)).toThrow(
        /ERR_PACKAGE_PATH_NOT_EXPORTED|not defined by "exports"/,
      );
    },
  );
});
