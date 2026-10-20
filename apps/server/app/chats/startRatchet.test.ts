import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const APP = resolve(__dirname, "..");
const ROOT = resolve(APP, "..");
const IDS = join(APP, "chats", "ids.ts");

const CONFIG = ts.findConfigFile(ROOT, ts.sys.fileExists, "tsconfig.json") as string;

/** Every file of the production program (app/, scripts/, loom.config.ts): the tsconfig's own file list. */
function sources(): string[] {
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(CONFIG, ts.sys.readFile).config,
    ts.sys,
    ROOT,
  );
  return parsed.fileNames.filter((f) => !f.endsWith(".d.ts"));
}

/** Every call the checker resolves to `Conversations.start`, with whether its `conversationId` is `chatConversationId(...)`. */
function scanStarts(files: string[], virtual = new Map<string, string>()) {
  const options = ts.parseJsonConfigFileContent(
    ts.readConfigFile(CONFIG, ts.sys.readFile).config,
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
  /** The callee is the function declared in app/chats/ids.ts, however it is imported or renamed. */
  const isChatConversationId = (callee: ts.Expression): boolean => {
    let symbol = checker.getSymbolAtLocation(callee);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return (
      symbol?.declarations?.some(
        (d) =>
          ts.isFunctionDeclaration(d) &&
          d.name?.text === "chatConversationId" &&
          d.getSourceFile().fileName === IDS,
      ) ?? false
    );
  };
  const idOk = (arg: ts.Expression | undefined): boolean => {
    if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
    const named = (n: string) =>
      arg.properties.some(
        (p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
          ts.isIdentifier(p.name) &&
          p.name.text === n,
      );
    return (
      named("principal") &&
      arg.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === "conversationId" &&
          ts.isCallExpression(p.initializer) &&
          isChatConversationId(p.initializer.expression),
      )
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

  // Only the create route (POST /api/chats) may call `Conversations.start`, with a chatConversationId.
  it("passes for every start in the real sources, and finds the create route's", () => {
    const found = scanStarts(sources());
    expect(found.filter((c) => !c.ok).map((c) => c.at)).toEqual([]);
    // P8: exactly one start in the whole program, in the create route.
    expect(found.map((c) => c.at.replace(/:\d+$/, ""))).toEqual(["chats/routes.ts"]);
  });

  it("flags a start without a principal", () => {
    expect(
      snippet("await c.start({ conversationId: chatConversationId(user, chat) });").map(
        (c) => c.ok,
      ),
    ).toEqual([false]);
  });

  it("flags a start whose callee only looks like chatConversationId", () => {
    const fake = scanStarts(
      [],
      new Map([
        [
          VIRTUAL,
          `import type { Conversations } from "@loom/conversation";
           declare const chatConversationId: (a: string, b: string) => string;
           declare const c: Conversations; declare const p: never;
           export async function f() { await c.start({ conversationId: chatConversationId("a", "b") as never, principal: p }); }`,
        ],
      ]),
    );
    expect(fake.map((c) => c.ok)).toEqual([false]);
  });
});
