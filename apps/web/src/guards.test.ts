import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// import.meta.dirname, not new URL(..., import.meta.url): happy-dom's global URL mangles file: URLs.
const SRC = import.meta.dirname;
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "testing" ? [] : files(p);
    return /\.(ts|css)$/.test(n) && !n.endsWith(".test.ts") ? [p] : [];
  });
}
const app = files(SRC);
const text = (p: string) => readFileSync(p, "utf8");
const rel = (p: string) => relative(SRC, p);

// The only files that may mint markup: dm-icon draws build-time SVG constants, dm-app picks a tag from a fixed table.
const MARKUP_ALLOWED = new Set(["dm-icon.ts", "dm-app.ts"]);
// The only file that may name a browser storage API: the theme store (it persists "dm-theme" and nothing else).
const STORAGE_ALLOWED = new Set(["state/theme.ts"]);

describe("the dependency and security rules of apps/web", () => {
  it("draws nothing as markup (D6): no unsafe* directive, innerHTML, outerHTML or insertAdjacentHTML", () => {
    for (const p of app) {
      if (MARKUP_ALLOWED.has(basename(p))) continue;
      expect(text(p), p).not.toMatch(
        /unsafeHTML|unsafeSVG|unsafeStatic|innerHTML|outerHTML|insertAdjacentHTML/,
      );
    }
  });
  it("is a thin surface (D14): no catalogue, no experience composition, no reshaper, no server package", () => {
    for (const p of app)
      expect(text(p), p).not.toMatch(
        /@docmind\/experiences|@docmind\/auth|@loom-ui\/core\/log|from "@loom-ui\/core"|from "@loom-ui\/hydration"|defineSemanticCatalog|defineReshapers|genesis\(/,
      );
  });
  it("imports no Loom package but the two browser runtimes", () => {
    for (const p of app)
      for (const m of text(p).matchAll(/from "(@loom\/[\w-]+)/g))
        expect(["@loom/projection-runtime", "@loom/blueprint-runtime"], p).toContain(m[1]);
  });
  it("stores nothing in the browser but the theme (D6)", () => {
    for (const p of app) {
      if (STORAGE_ALLOWED.has(rel(p))) continue;
      expect(text(p), p).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    }
  });
});
