import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
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
         import { legacyIds } from "./opaqueIds";
         declare const rt: WorkflowRuntime; declare const flow: never; declare const user: string;
         export async function f() { ${body} }`,
      ],
    ]),
  );

describe("execution ids", () => {
  it("accepts a start and a fork whose executionId comes from an id builder", () => {
    expect(
      snippet(`await rt.start(flow, {}, { executionId: legacyIds.named(user, "n") });`),
    ).toEqual([{ at: "__virtual__.ts:4", ok: true }]);
    const forked = `const id = legacyIds.named(user, "n"); await rt.fork("e", 3, { executionId: id });`;
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

/**
 * SCOPE: non-test TypeScript under apps/server/app and the SQL in infra/migrations numbered after 0038. apps/loadtest, scripts/ and packages/ are out of scope.
 * Where an id is built or parsed outside `opaqueIds` (R14, spec O5): every string, template, template part or regex literal that carries
 * an id's shape, and every import of Loom UI's lineage stream prefix. `virtual` adds in-memory files so the scan itself can be tested.
 */
const ID_SHAPES: readonly RegExp[] = [
  /^\^?[uh]_/, // the user prefixes: `u_<uuid>` and `h_<handle>`
  /:(?:ingest|visualize|suggest-tags|chat-title)-/, // a flow name after a user prefix
  /\.c-/, // a conversation id
  /^\^?(?:turn)?visuals-(?:\(|$)/, // a lineage line: the head of `visuals-${...}` or of a regex `^visuals-(...)`
  /\\b\(\?:turn\)\?visuals-/, // a lineage regex headed by a word boundary: `\b(?:turn)?visuals-...`
  /\[uh\]_/, // a user-prefix regex or template: `\b[uh]_...`
  /\[a-z2-7\]\{(?:25|26|52)\}/, // a handle or lineage token character class
];

/** Where the SQL scan looks: a SQL string that builds an id prefix or flow name by concatenation. */
const SQL_ID_SHAPES: readonly RegExp[] = [
  /'[uh]_'\s*\|\|/,
  /\|\|\s*'[uh]_/,
  /'(?:turn)?visuals-'\s*\|\|/,
  /\|\|\s*':(?:ingest|visualize|suggest-tags|chat-title)-/,
  /\|\|\s*'\.c-/,
];
const MIGRATIONS = resolve(ROOT, "..", "..", "infra", "migrations");
/**
 * Migrations 0001 to 0038 are applied and immutable, and they build old-format ids in SQL (0038 rewrote the stored ids once; the
 * earlier ones are the old-format sweeps and views). The ratchet guards what is written after them: a new migration may not build an id.
 */
const MAY_BUILD_IDS_IN_SQL = (file: string): boolean => Number(file.slice(0, 4)) <= 38;
const sqlIdShapesIn = (files: Map<string, string>): string[] =>
  [...files].flatMap(([name, text]) =>
    text
      .split("\n")
      .flatMap((line, i) =>
        SQL_ID_SHAPES.some((shape) => shape.test(line)) ? [`${name}:${i + 1}`] : [],
      ),
  );

function idShapesIn(files: string[], virtual = new Map<string, string>()): string[] {
  const hits = new Set<string>();
  const scan = (name: string, text: string) => {
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      let literal: string | undefined;
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      )
        literal = node.text;
      else if (ts.isRegularExpressionLiteral(node))
        literal = node.text.replace(/^\/|\/[a-z]*$/g, "");
      const imported = ts.isImportSpecifier(node) && node.name.text === "LINEAGE_STREAM_PREFIX";
      if (
        imported ||
        (literal !== undefined && ID_SHAPES.some((shape) => shape.test(literal as string)))
      ) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        hits.add(`${name.startsWith(APP) ? name.slice(APP.length + 1) : name}:${line}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  };
  for (const file of files) scan(file, readFileSync(file, "utf8"));
  for (const [name, text] of virtual) scan(name, text);
  return [...hits];
}

/** The one named file outside `opaqueIds/` that may name an id's shape: it asserts about the ids themselves (what survives an erasure). */
const MAY_NAME_IDS = new Set(["erasure/e2eSupport.ts"]);

describe("no id is built or parsed outside opaqueIds", () => {
  it.each([
    ["an old-format user prefix", "export const a = `u_${user}:ingest-${doc}`;"],
    ["a new-format prefix", 'export const a = "h_" + handle;'],
    ["a flow name", 'export const a = ":visualize-" + doc;'],
    ["a conversation separator", "export const a = `${prefix}.c-${chat}`;"],
    ["a lineage template", "export const a = `visuals-${user}-${doc}`;"],
    ["a turn lineage regex", "export const a = new RegExp(`^turnvisuals-(${U})`);"],
    ["a lineage regex literal", "export const a = /^visuals-(x)/;"],
    ["the lineage stream prefix", 'import { LINEAGE_STREAM_PREFIX } from "@loom-ui/lineage";'],
  ])("flags %s (the scan is not blind)", (_name, body) => {
    expect(idShapesIn([], new Map([[join(APP, "__virtual__.ts"), body]]))).toEqual([
      "__virtual__.ts:1",
    ]);
  });

  it("does not flag a failure code, a step id or ordinary text that only starts like a lineage word", () => {
    const body = [
      'export const a = "visuals-model-unavailable";',
      'export const b = "visualize-extract";',
      'export const c = "chat-title";',
      'export const d = "the h_ prefix is documented elsewhere";',
    ].join("\n");
    expect(idShapesIn([], new Map([[join(APP, "__virtual__.ts"), body]]))).toEqual([]);
  });

  it("finds none in the real sources, beyond opaqueIds and the one named support file", () => {
    const real = sources(APP).filter(
      (f) =>
        !f.startsWith(join(APP, "opaqueIds") + sep) && !MAY_NAME_IDS.has(f.slice(APP.length + 1)),
    );
    expect(real.length).toBeGreaterThan(100); // the scan reads the program, not an empty list
    expect(idShapesIn(real)).toEqual([]);
  });
});

describe("no migration builds an id in SQL", () => {
  it.each([
    ["a user prefix", "SET id = 'u_' || owner_id;"],
    ["a handle prefix", "SET id = 'h_' || handle;"],
    ["a lineage prefix", "SET l = 'visuals-' || owner;"],
    ["a flow name", "SET id = owner || ':ingest-' || doc;"],
    ["a conversation separator", "SET id = owner || '.c-' || chat;"],
  ])("flags %s (the scan is not blind)", (_name, line) => {
    expect(sqlIdShapesIn(new Map([["x.sql", `-- c\n${line}`]]))).toEqual(["x.sql:2"]);
  });

  it("finds none in the real migrations beyond the one allow-listed", () => {
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(30);
    expect(MAY_BUILD_IDS_IN_SQL("0038_opaque_ids.sql")).toBe(true);
    expect(MAY_BUILD_IDS_IN_SQL("0039_next.sql")).toBe(false);
    const real = new Map(
      files
        .filter((f) => !MAY_BUILD_IDS_IN_SQL(f))
        .map((f) => [f, readFileSync(join(MIGRATIONS, f), "utf8")] as const),
    );
    expect(sqlIdShapesIn(real)).toEqual([]);
  });
});

/**
 * Where a chat family's builder is called directly (`UserIds.conversation|chatTitle|turnVisualize|turnLineage`, or the same names on
 * `legacyIds`) outside `opaqueIds`. Phase 2: only the resolver (`chats/chatIds.ts`), the eraser (`erasure/wire.ts`, which must name both
 * formats of a chat), the legacy conversation builder (`chats/ids.ts`) and the test-only legacy turn builders
 * (`flows/visualize-turn/testing.ts`) may; everything else asks `ChatIdResolver`, so no call site can pick a format of its own.
 */
const CHAT_BUILDERS = new Set(["conversation", "chatTitle", "turnVisualize", "turnLineage"]);
const MAY_BUILD_CHAT_IDS = new Set([
  "chats/chatIds.ts",
  "erasure/wire.ts",
  "chats/ids.ts",
  "flows/visualize-turn/testing.ts",
]);
/**
 * `legacyChatConversationId` is a plain function, not a builder method, so it is flagged by name: outside tests only the resolver and the
 * chat test support (which builds a legacy chat on purpose) may call it. Production code asks the resolver.
 */
const LEGACY_CONVERSATION = "legacyChatConversationId";
const MAY_CALL_LEGACY_CONVERSATION = new Set([
  "chats/chatIds.ts",
  "chats/testing.ts",
  "chats/testStack.ts",
  "chats/testHarness.ts",
  "chats/e2eSupport.ts",
]);

type CalleeRule = (callee: ts.Expression) => boolean;
const isBuilderCall: CalleeRule = (callee) =>
  ts.isPropertyAccessExpression(callee) && CHAT_BUILDERS.has(callee.name.text);
const isLegacyConversationCall: CalleeRule = (callee) =>
  ts.isIdentifier(callee) && callee.text === LEGACY_CONVERSATION;

function chatBuilderCalls(
  files: string[],
  virtual = new Map<string, string>(),
  flagged: CalleeRule = isBuilderCall,
): string[] {
  const hits: string[] = [];
  const scan = (name: string, text: string) => {
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && flagged(node.expression)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        hits.push(`${name.startsWith(APP) ? name.slice(APP.length + 1) : name}:${line}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  };
  for (const file of files) scan(file, readFileSync(file, "utf8"));
  for (const [name, text] of virtual) scan(name, text);
  return hits;
}

describe("no chat id is built outside the resolver and the eraser", () => {
  it.each([
    ["a legacy conversation", "legacyIds.conversation(user, chat);"],
    ["a legacy title", "legacyIds.chatTitle(user, chat);"],
    ["a legacy turn run", "legacyIds.turnVisualize(user, chat, 1);"],
    ["a legacy turn line", "legacyIds.turnLineage(user, chat, 1);"],
    ["a new-format conversation", "ids.conversation(chat);"],
    ["a new-format title", "userIds.chatTitle(chat);"],
    ["a new-format turn run", "userIds.turnVisualize(chat, 1, 2);"],
    ["a new-format turn line", "userIds.turnLineage(chat, 1);"],
  ])("flags %s (the scan is not blind)", (_name, body) => {
    expect(
      chatBuilderCalls(
        [],
        new Map([[join(APP, "__virtual__.ts"), `export const x = () => { ${body} };`]]),
      ),
    ).toEqual(["__virtual__.ts:1"]);
  });

  it("flags a direct call of the legacy conversation builder, by name", () => {
    const body = "export const x = () => { legacyChatConversationId(user, chat); };";
    expect(
      chatBuilderCalls(
        [],
        new Map([[join(APP, "__virtual__.ts"), body]]),
        isLegacyConversationCall,
      ),
    ).toEqual(["__virtual__.ts:1"]);
  });

  it("does not flag the resolver's own method names or a document builder", () => {
    const body =
      "export const x = () => { ids.conversationId(); ids.titleExecutionId(); ids.turnExecutionId(1); ids.turnExperienceId(1); user.ingest(d, 1); };";
    expect(chatBuilderCalls([], new Map([[join(APP, "__virtual__.ts"), body]]))).toEqual([]);
  });

  it("finds none in the real sources beyond opaqueIds, the resolver, the eraser, the legacy conversation builder and the test-only legacy turn builders", () => {
    const real = sources(APP).filter(
      (f) =>
        !f.startsWith(join(APP, "opaqueIds") + sep) &&
        !MAY_BUILD_CHAT_IDS.has(f.slice(APP.length + 1)),
    );
    expect(real.length).toBeGreaterThan(100);
    expect(chatBuilderCalls(real)).toEqual([]);
  });

  it("finds no call of legacyChatConversationId in the real sources beyond the resolver and the chat test support", () => {
    const real = sources(APP).filter(
      (f) => !MAY_CALL_LEGACY_CONVERSATION.has(f.slice(APP.length + 1)),
    );
    expect(real.length).toBeGreaterThan(100);
    expect(chatBuilderCalls(real, new Map(), isLegacyConversationCall)).toEqual([]);
  });
});
