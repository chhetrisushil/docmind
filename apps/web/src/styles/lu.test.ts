import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "tokens.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const LU = [
  "text",
  "text-dim",
  "text-caption",
  "border",
  "panel",
  "panel-2",
  "grid",
  "accent",
  "radius",
  "delta-up",
  "delta-up-bg",
  "delta-down",
  "delta-down-bg",
  "delta-flat",
  "delta-flat-bg",
  "status-ok",
  "status-warning",
  "status-critical",
];

describe("the --lu-* bridge", () => {
  it.each(LU)("--lu-%s is defined from the --dm tokens", (name) => {
    const m = new RegExp(`--lu-${name}\\s*:\\s*([^;]+);`).exec(css);
    expect(m?.[1], name).toMatch(/var\(--dm-/);
  });
  it("is defined outside the theme blocks, so both themes follow", () => {
    expect(/^:root\s*\{[^}]*--lu-text:/m.test(css)).toBe(true);
    expect(/:root\[data-theme="light"\]\s*\{[^}]*--lu-/.test(css)).toBe(false);
  });
});
