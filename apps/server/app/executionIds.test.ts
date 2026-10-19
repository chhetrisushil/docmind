import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const APP = resolve(__dirname);
const ROOT = resolve(APP, "..");
const CREATORS = new Set(["start", "fork"]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    const isSource = path.endsWith(".ts") && !path.endsWith(".test.ts");
    return isSource && entry.name !== "loom.gen.ts" ? [path] : [];
  });
}

/**
 * Every call that the type checker resolves to WorkflowRuntime.start or .fork, with the verdict on
 * its `executionId`. `virtual` adds in-memory files so the scan itself can be tested.
 */
function scanStarts(files: string[], virtual = new Map<string, string>()) {
  const config = ts.findConfigFile(ROOT, ts.sys.fileExists, "tsconfig.json") as string;
  const options = ts.parseJsonConfigFileContent(
    ts.readConfigFile(config, ts.sys.readFile).config,
    ts.sys,
    ROOT,
  ).options;
  const host = ts.createCompilerHost(options);
  const realSource = host.getSourceFile.bind(host);
  const realExists = host.fileExists.bind(host);
  host.fileExists = (name) => virtual.has(name) || realExists(name);
  host.getSourceFile = (name, lang, ...rest) =>
    virtual.has(name)
      ? ts.createSourceFile(name, virtual.get(name) as string, lang)
      : realSource(name, lang, ...rest);
  const program = ts.createProgram([...files, ...virtual.keys()], options, host);
  const checker = program.getTypeChecker();
  const found: { at: string; ok: boolean }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const decl = checker.getResolvedSignature(node)?.declaration;
      const owner = decl?.parent;
      const name = decl && "name" in decl && decl.name ? (decl.name as ts.Identifier).text : "";
      if (
        owner &&
        ts.isClassDeclaration(owner) &&
        owner.name?.text === "WorkflowRuntime" &&
        CREATORS.has(name)
      ) {
        const sf = node.getSourceFile();
        const options = node.arguments[node.arguments.length - 1];
        const prop = options && checker.getTypeAtLocation(options).getProperty("executionId");
        const type = prop && checker.getTypeOfSymbolAtLocation(prop, options as ts.Node);
        const ok =
          !!type && checker.getNonNullableType(type).aliasSymbol?.name === "UserExecutionId";
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        found.push({ at: `${sf.fileName.slice(APP.length + 1)}:${line}`, ok });
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const file of [...files, ...virtual.keys()]) {
    const sf = program.getSourceFile(file);
    if (sf) visit(sf);
  }
  return found;
}

const VIRTUAL = join(APP, "__virtual__.ts");
const snippet = (body: string) =>
  scanStarts(
    [],
    new Map([
      [
        VIRTUAL,
        `import type { WorkflowRuntime } from "@loom/workflow-runtime";
         import { executionIdFor } from "./subject";
         declare const rt: WorkflowRuntime; declare const flow: never; declare const user: string;
         export async function f() { ${body} }`,
      ],
    ]),
  );

describe("execution ids", () => {
  it("accepts a start and a fork whose executionId comes from executionIdFor", () => {
    expect(
      snippet(`await rt.start(flow, {}, { executionId: executionIdFor(user, "n") });`),
    ).toEqual([{ at: "__virtual__.ts:4", ok: true }]);
    const forked = `const id = executionIdFor(user, "n"); await rt.fork("e", 3, { executionId: id });`;
    expect(snippet(forked).map((c) => c.ok)).toEqual([true]);
  });

  it.each([
    ["a literal id", `await rt.start(flow, {}, { executionId: "x" });`],
    ["no id at all", "await rt.start(flow, {}, {});"],
    ["a fork with a template id", "await rt.fork('e', 3, { executionId: `${user}:x` });"],
    ["an element-access call", `await rt["start"](flow, {}, { executionId: String(1) });`],
    ["an aliased method", "const s = rt.start; await s(flow, {}, { executionId: user });"],
  ])("flags %s", (_name, body) => {
    expect(snippet(body).map((c) => c.ok)).toEqual([false]);
  });

  it("finds at least one real start, and every real start and fork passes", () => {
    const calls = scanStarts(sources(APP));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => !c.ok).map((c) => c.at)).toEqual([]);
  });
});
