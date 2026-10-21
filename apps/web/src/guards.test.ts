import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// import.meta.dirname, not new URL(..., import.meta.url): happy-dom's global URL mangles file: URLs.
const SRC = import.meta.dirname;
const ROOT = join(SRC, ".."); // apps/web
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "testing" ? [] : files(p);
    return /\.(ts|tsx|js|mjs|css|html|svg)$/.test(n) && !/\.test\.[tj]sx?$/.test(n) ? [p] : [];
  });
}
// Everything shipped to the browser: src/**, public/ (if any) and the page itself.
const publicDir = join(ROOT, "public");
const app = [
  ...files(SRC),
  ...(existsSync(publicDir) ? files(publicDir) : []),
  join(ROOT, "index.html"),
].map((p) => ({
  path: rel(p),
  text: readFileSync(p, "utf8"),
}));

// Allowlists are exact relative paths, never basenames.
// dm-icon draws build-time SVG constants; dm-app picks a tag from a fixed table.
const MARKUP_ALLOWED = new Set(["src/components/dm-icon.ts", "src/components/dm-app.ts"]);
// The theme store persists the "dm-theme" key and nothing else.
const STORAGE_ALLOWED = new Set(["src/state/theme.ts"]);
const THEME_KEY = "dm-theme";

/** Every module specifier a source imports: `from "x"`, bare `import "x"`, dynamic `import("x")`. */
function specifiers(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\bfrom\s*(["'])([^"'\n]+)\1/g,
    /\bimport\s*(["'])([^"'\n]+)\1/g,
    /\bimport\s*\(\s*(["'`])([^"'`\n]+)\1\s*\)/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) out.push(m[2] as string);
  return out;
}

const BROWSER_LOOM = ["@loom/projection-runtime", "@loom/blueprint-runtime"];
const isServerOnly = (s: string) =>
  /^@docmind\/(experiences|auth)(\/|$)/.test(s) ||
  /^@loom-ui\/core\/log(\/|$)/.test(s) ||
  s === "@loom-ui/core" ||
  s === "@loom-ui/hydration" ||
  /^@loom-ui\/renderer-terminal(\/|$)/.test(s);
const isForbiddenLoom = (s: string) => {
  if (!s.startsWith("@loom/")) return false;
  return !BROWSER_LOOM.some((ok) => s === ok || s.startsWith(`${ok}/`));
};

const MARKUP = /unsafeHTML|unsafeSVG|unsafeStatic|unsafeCSS|innerHTML|outerHTML|insertAdjacentHTML/;
// Never allowed anywhere: other ways to turn a string into markup or code.
const INJECTION =
  /\bsrcdoc\b|createContextualFragment|\bDOMParser\b|\beval\s*\(|\bnew\s+Function\s*\(|(?<![\w$.])Function\s*\(|\bdocument\s*\.\s*write(?:ln)?\s*\(|setHTMLUnsafe|parseHTMLUnsafe|\bdocument\s*\.\s*cookie\b|\bcookieStore\b|(?<![\w$.])require\s*\(/;
const THIN = /defineSemanticCatalog|defineReshapers|genesis\(|@docmind\/experiences|@docmind\/auth/;
const STORAGE = /localStorage|sessionStorage|indexedDB/;
// window["local" + "Storage"] hides the name from STORAGE, so bracket access directly on window/globalThis/self is
// refused outright (not `this.frames[i]`, `node.parent[key]`, `top[1]` or CSS such as `.window[open]`).
const GLOBAL_BRACKET = /(?<![\w$.#-])(?:window|globalThis|self)(?:\?\.)?\[/;

/** Rule names an app file breaks; empty when it is clean. */
function violations(path: string, text: string): string[] {
  const bad: string[] = [];
  const specs = specifiers(text);
  if (specs.some(isServerOnly) || THIN.test(text)) bad.push("server-only");
  if (specs.some(isForbiddenLoom)) bad.push("loom-package");
  if (!MARKUP_ALLOWED.has(path) && MARKUP.test(text)) bad.push("markup");
  if (INJECTION.test(text)) bad.push("injection");
  if (!path.endsWith(".css") && GLOBAL_BRACKET.test(text)) bad.push("global-bracket");
  if (!STORAGE_ALLOWED.has(path) && STORAGE.test(text)) bad.push("storage");
  if (STORAGE_ALLOWED.has(path)) bad.push(...themeStorageViolations(text));
  return bad;
}

/** In the theme store: only `dm-theme` may be read or written, nothing may be enumerated or cleared. */
function themeStorageViolations(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const bad: string[] = [];
  if (/sessionStorage|indexedDB|\.clear\s*\(|\.key\s*\(|\.removeItem\s*\(/.test(text))
    bad.push("theme-storage-api");
  if (
    /\blocalStorage\s*(?:\?\.)?\s*(?:\[|\.\w+\s*=(?!=))|\[\s*["'`](?:get|set|remove)Item["'`]\s*\]/.test(
      text,
    )
  )
    bad.push("theme-storage-member");
  if (!new RegExp(`const KEY = "${THEME_KEY}";`).test(text)) bad.push("theme-key-const");
  for (const m of text.matchAll(/\b(?:getItem|setItem)\s*\(\s*([^,)]*)/g)) {
    const arg = (m[1] as string).trim();
    // Property signatures like `getItem(key: string)` are types, not calls.
    if (/^[\w$]+\s*:/.test(arg)) continue;
    if (arg !== "KEY") bad.push("theme-key-arg");
  }
  return bad;
}

describe("the dependency and security rules of apps/web", () => {
  it("scans the page and the sources (a self-check that the walk found them)", () => {
    const paths = app.map((a) => a.path);
    expect(paths).toContain("index.html");
    expect(paths).toContain("src/main.ts");
    expect(paths).toContain("src/state/theme.ts");
  });
  it("breaks none of the rules: no server package, only the two Loom browser runtimes, no markup minting, no injection, no storage but dm-theme", () => {
    for (const a of app) expect(violations(a.path, a.text), a.path).toEqual([]);
  });
});

// Allowlisted files that a later task creates; every other allowlisted path must exist now, so a typo is caught.
const CREATED_BY_LATER_TASK = new Set(["src/components/dm-app.ts"]); // Task 181
describe("the allowlists", () => {
  it("name files that exist, or are listed as created by a later task", () => {
    const paths = new Set(app.map((a) => a.path));
    for (const p of [...MARKUP_ALLOWED, ...STORAGE_ALLOWED])
      expect(paths.has(p) || CREATED_BY_LATER_TASK.has(p), p).toBe(true);
    for (const p of CREATED_BY_LATER_TASK)
      expect(MARKUP_ALLOWED.has(p) || STORAGE_ALLOWED.has(p), p).toBe(true);
  });
});

describe("the guards catch what they claim to (fixture strings, not real files)", () => {
  const MISC = "src/components/dm-x.ts";
  const THEME = "src/state/theme.ts";
  const GOOD_THEME = [
    `const KEY = "${THEME_KEY}";`,
    "env.localStorage?.getItem(KEY);",
    "env.localStorage?.setItem(KEY, choice);",
  ].join("\n");

  it("accepts clean sources and the real theme shape", () => {
    expect(violations(MISC, `import { html } from "lit";\nimport "./dm-icon";`)).toEqual([]);
    expect(violations(MISC, `import "@loom/projection-runtime";`)).toEqual([]);
    expect(violations(MISC, `const m = await import("@loom/blueprint-runtime");`)).toEqual([]);
    expect(violations(THEME, GOOD_THEME)).toEqual([]);
  });

  it.each([
    ["static double-quoted", `import { a } from "@docmind/experiences";`],
    ["static single-quoted", `import { a } from '@docmind/auth';`],
    ["bare", `import "@loom-ui/core/log";`],
    ["bare single", `import '@loom-ui/hydration';`],
    ["dynamic", `const m = await import("@loom-ui/core");`],
    ["export-from", `export * from "@loom-ui/renderer-terminal";`],
    ["renderer-terminal subpath", `import x from "@loom-ui/renderer-terminal/dist/x.js";`],
    ["multi-line", `import {\n  a,\n} from\n  "@docmind/auth";`],
  ])("server-only specifier, %s", (_n, src) => {
    expect(violations(MISC, src)).toContain("server-only");
  });

  it.each([
    ["static", `import { a } from "@loom/pg-store";`],
    ["bare", `import "@loom/kernel";`],
    ["dynamic", `await import('@loom/blueprint-engine');`],
    ["lookalike of an allowed runtime", `import x from "@loom/projection-runtime-server";`],
  ])("a Loom package that is not a browser runtime, %s", (_n, src) => {
    expect(violations(MISC, src)).toContain("loom-package");
  });

  it("does not mistake a string that merely mentions a package for an import", () => {
    expect(violations(MISC, `const doc = "see @loom/kernel for details";`)).toEqual([]);
  });

  it.each([
    "unsafeHTML(x)",
    "el.innerHTML = x",
    "el.outerHTML = x",
    "el.insertAdjacentHTML('beforeend', x)",
    `import { unsafeSVG } from "lit/directives/unsafe-svg.js"; unsafeSVG(x)`,
  ])("markup minting outside the allowlist: %s", (src) => {
    expect(violations(MISC, src)).toContain("markup");
    expect(violations("src/components/dm-icon.ts", src)).not.toContain("markup");
  });

  it("allowlists are exact paths, not basenames", () => {
    expect(violations("src/other/dm-icon.ts", "el.innerHTML = x")).toContain("markup");
    expect(violations("src/other/theme.ts", "localStorage.getItem('dm-theme')")).toContain(
      "storage",
    );
  });

  it.each([
    ["srcdoc", "iframe.srcdoc = x;"],
    ["srcdoc in markup", `<iframe srcdoc="x"></iframe>`],
    ["createContextualFragment", "range.createContextualFragment(x)"],
    ["DOMParser", `new DOMParser().parseFromString(x, "text/html")`],
    ["eval", "eval(x)"],
    ["eval with space", "eval (x)"],
    ["new Function", `new Function("return 1")`],
    ["Function call", `Function("return 1")()`],
  ])("injection sink, %s, is refused even in an allowlisted file", (_n, src) => {
    expect(violations(MISC, src)).toContain("injection");
    expect(violations("src/components/dm-icon.ts", src)).toContain("injection");
    expect(violations(THEME, `${GOOD_THEME}\n${src}`)).toContain("injection");
  });

  it("does not flag words that merely contain a sink name", () => {
    expect(violations(MISC, "const retrieval = 1; medieval(x);")).toEqual([]);
  });

  it.each([
    `localStorage.setItem("a", "b")`,
    `window["localStorage"].setItem("a", "b")`,
    `window['sessionStorage']`,
    `globalThis["indexedDB"]`,
    "indexedDB.open('x')",
  ])("storage outside the theme store: %s", (src) => {
    const got = violations(MISC, src);
    expect(got.some((r) => r === "storage" || r === "global-bracket")).toBe(true);
  });

  it.each([
    "this.frames[i]",
    "node.parent[key]",
    "const top = stack[0]; top[1]",
    "windowSize[i]",
    "const w = parent[key]",
    "my.window[i]",
  ])("bracket access that is not on a global is fine: %s", (src) => {
    expect(violations(MISC, src)).toEqual([]);
  });

  it("does not read CSS selectors as global bracket access", () => {
    const css = ".top[hidden] { } .parent [data-x] { } .window[open] { } self[x] { }";
    expect(violations("src/styles/x.css", css)).toEqual([]);
    expect(
      violations(MISC, "css`.top[hidden] { } .parent [data-x] { } .window[open] { }`"),
    ).toEqual([]);
  });

  it.each(["window[i]", "globalThis?.[k]", `self["x"]`])(
    "global bracket access is caught: %s",
    (src) => {
      expect(violations(MISC, src)).toContain("global-bracket");
    },
  );

  it.each([
    "document.write(x)",
    "document.writeln(x)",
    "el.setHTMLUnsafe(x)",
    "Document.parseHTMLUnsafe(x)",
    "document.cookie = 'a=b'",
    "cookieStore.set('a', 'b')",
    "const m = require('x')",
  ])("further sinks are caught everywhere: %s", (src) => {
    expect(violations(MISC, src)).toContain("injection");
    expect(violations("src/components/dm-icon.ts", src)).toContain("injection");
  });

  it("unsafeCSS is markup minting", () => {
    expect(violations(MISC, "unsafeCSS(x)")).toContain("markup");
  });

  it("refuses computed bracket access on a global, which hides the storage name", () => {
    expect(violations(MISC, `window["local" + "Storage"].clear()`)).toContain("global-bracket");
    expect(violations(THEME, `${GOOD_THEME}\nwindow["local" + "Storage"]`)).toContain(
      "global-bracket",
    );
  });

  it.each([
    ["another key", `${GOOD_THEME}\nenv.localStorage?.setItem("token", t);`],
    ["a variable key", `${GOOD_THEME}\nenv.localStorage?.getItem(name);`],
    ["setItem with a literal other key", `${GOOD_THEME}\nlocalStorage.setItem('title', t)`],
    ["clear", `${GOOD_THEME}\nenv.localStorage.clear();`],
    ["enumerating keys", `${GOOD_THEME}\nenv.localStorage.key(0);`],
    ["bracket member", `${GOOD_THEME}\nenv.localStorage?.["setItem"]("token", t);`],
    ["bracket key", `${GOOD_THEME}\nenv.localStorage["x"];`],
    ["property assignment", `${GOOD_THEME}\nenv.localStorage.token = t;`],
    [
      "KEY only in a comment",
      GOOD_THEME.replace('const KEY = "dm-theme";', '// const KEY = "dm-theme";\nconst KEY = "x";'),
    ],
    ["removeItem", `${GOOD_THEME}\nenv.localStorage.removeItem(KEY);`],
    ["sessionStorage", `${GOOD_THEME}\nsessionStorage.setItem(KEY, "x");`],
    ["indexedDB", `${GOOD_THEME}\nindexedDB.open("x");`],
    ["a changed key constant", GOOD_THEME.replace(THEME_KEY, "dm-session")],
  ])("in the theme store, %s is caught", (_n, src) => {
    expect(violations(THEME, src).length).toBeGreaterThan(0);
  });

  it("applies to .html: a module script's import and an inline sink are caught", () => {
    const page = `<script type="module">import "@loom/kernel"; import x from '@docmind/auth';</script>`;
    expect(violations("index.html", page)).toEqual(
      expect.arrayContaining(["loom-package", "server-only"]),
    );
    expect(violations("index.html", "<script>localStorage.x = 1; eval(y)</script>")).toEqual(
      expect.arrayContaining(["storage", "injection"]),
    );
  });
});
