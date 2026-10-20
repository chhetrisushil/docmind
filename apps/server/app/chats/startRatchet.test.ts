import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const APP = resolve(__dirname, "..");
const ROOT = resolve(APP, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    const isSource = path.endsWith(".ts") && !path.endsWith(".test.ts");
    return isSource && entry.name !== "loom.gen.ts" ? [path] : [];
  });
}

/** Every call the checker resolves to `Conversations.start`, with whether its `conversationId` is `chatConversationId(...)`. */
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
  const idOk = (arg: ts.Expression | undefined): boolean => {
    if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
    return arg.properties.some(
      (p) =>
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === "conversationId" &&
        ts.isCallExpression(p.initializer) &&
        ts.isIdentifier(p.initializer.expression) &&
        p.initializer.expression.text === "chatConversationId",
    );
  };
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const decl = checker.getResolvedSignature(node)?.declaration;
      const owner = decl?.parent;
      const name = decl && "name" in decl && decl.name ? (decl.name as ts.Identifier).text : "";
      if (
        owner &&
        ts.isInterfaceDeclaration(owner) &&
        owner.name.text === "Conversations" &&
        name === "start"
      ) {
        const sf = node.getSourceFile();
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        found.push({
          at: `${sf.fileName.slice(APP.length + 1)}:${line}`,
          ok: idOk(node.arguments[0]),
        });
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

const VIRTUAL = join(APP, "__virtual_chat__.ts");
const snippet = (body: string) =>
  scanStarts(
    [],
    new Map([
      [
        VIRTUAL,
        `import type { Conversations } from "@loom/conversation";
         import { chatConversationId } from "./chats/ids";
         declare const c: Conversations; declare const user: string; declare const chat: string; declare const p: never;
         export async function f() { ${body} }`,
      ],
    ]),
  );

describe("Conversations.start", () => {
  it("accepts a start whose conversationId is chatConversationId(...)", () => {
    expect(
      snippet("await c.start({ conversationId: chatConversationId(user, chat), principal: p });"),
    ).toEqual([{ at: "__virtual_chat__.ts:4", ok: true }]);
  });

  it.each([
    ["no argument", "await c.start();"],
    ["no conversationId (Loom would mint a conv-<uuid>)", "await c.start({ principal: p });"],
    ["a literal id", `await c.start({ conversationId: "conv-1" });`],
    [
      "a variable",
      "const id = chatConversationId(user, chat); await c.start({ conversationId: id });",
    ],
    ["a cast", "await c.start({ conversationId: `u_${user}` as never });"],
    [
      "a spread",
      "const o = { conversationId: chatConversationId(user, chat) }; await c.start({ ...o });",
    ],
  ])("flags %s", (_name, body) => {
    expect(snippet(body).map((c) => c.ok)).toEqual([false]);
  });

  // Only the create route (POST /api/chats) may call `Conversations.start` with a chatConversationId.
  // No call exists until Task 149, which adds the first and also asserts that at least one real call
  // is found (PF10); until then this checks every call it finds and does not require one.
  it("passes for every start in the real sources", () => {
    expect(
      scanStarts(sources(APP))
        .filter((c) => !c.ok)
        .map((c) => c.at),
    ).toEqual([]);
  });
});
