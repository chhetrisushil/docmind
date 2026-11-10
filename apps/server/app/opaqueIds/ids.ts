import { ORD_PATTERN } from "@docmind/contracts";
import { LINEAGE_STREAM_PREFIX } from "@loom-ui/lineage";
import { isValidConversationId } from "@loom/conversation";
import { MAX_EXECUTION_ID_BYTES } from "@loom/plugin-postgres";
import { type IdKey, TOKEN_LENGTH, sealToken } from "./siv";

/** The canonical lower-case UUID source (8-4-4-4-12), defined once; `chats/ids.ts` re-exports it. */
export const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CANONICAL = new RegExp(`^${UUID_PATTERN}$`);
const U = UUID_PATTERN;
// One spelling per value: a 26-character handle holds 128 bits, so its last character carries 2 padding bits that must be zero
// (`a e i m q u y 4`); a 52-character token holds 256 bits, so its last carries 4 zero bits (`a q`). The strict decoder already
// refuses any other spelling of a token; the shapes below refuse it everywhere else (the parse regexes and the column CHECK).
const H = "[a-z2-7]{25}[aeimquy4]";
/** The shape of a handle, for a check before any lookup. */
export const HANDLE_RE = new RegExp(`^${H}$`);
const T = `[a-z2-7]{${TOKEN_LENGTH - 1}}[aq]`;
const GEN = "[1-9][0-9]{0,8}";
// A new-format ingest or visualize generation suffix is `.2` and up: generation 1 has no suffix, so `.1` would be a second spelling.
const GEN_NEW = "(?:[2-9]|[1-9][0-9]{1,8})";
const RERUN = "[1-9][0-9]{0,2}";
const MAX_GENERATION = 999_999_999;
const MAX_RERUN = 999;

declare const userExecution: unique symbol;
/**
 * An execution id built by this module. A plain string is not assignable to it, so a start or fork that passes `executionId` from
 * anywhere else is caught by the ratchet in executionIds.test.ts.
 */
export type UserExecutionId = string & { readonly [userExecution]: true };
declare const chatConversation: unique symbol;
/** A conversation id built by this module (`Conversations.start` takes nothing else; chats/startRatchet.test.ts). */
export type ChatConversationId = string & { readonly [chatConversation]: true };

/** The families of id the app builds. */
export type IdFamily =
  | "ingest"
  | "visualize"
  | "turnVisualize"
  | "suggestTags"
  | "chatTitle"
  | "conversation"
  | "documentLineage"
  | "turnLineage";

/** What an id names. `generation` is the INGEST generation (1 when the id has no suffix); `rerun` is 0 for an automatic run. */
export interface ParsedId {
  format: "legacy" | "opaque";
  family: IdFamily;
  userId: string;
  documentId?: string;
  chatId?: string;
  generation?: number;
  rerun?: number;
  ord?: number;
}

/** An opaque id before its tokens are opened: everything the id shows without the key. */
export interface OpaqueShape {
  family: IdFamily;
  handle: string;
  documentToken?: string;
  chatToken?: string;
  generation?: number;
  rerun?: number;
  ord?: number;
}

type Rule = {
  family: IdFamily;
  re: RegExp;
  read(m: RegExpExecArray): Omit<ParsedId, "format" | "family" | "userId"> & { userId?: string };
};
const num = (v: string | undefined, dflt?: number): number | undefined =>
  v === undefined ? dflt : Number(v);

/** Old format: the user and the document or chat as plain UUIDs. */
const LEGACY: readonly Rule[] = [
  {
    family: "ingest",
    re: new RegExp(`^u_(${U}):ingest-(${U})(?:\\.(${GEN}))?$`),
    read: (m) => ({
      userId: m[1] as string,
      documentId: m[2] as string,
      generation: num(m[3], 1) as number,
    }),
  },
  {
    family: "visualize",
    re: new RegExp(`^u_(${U}):visualize-(${U})(?:\\.(${GEN}))?(?:-r(${RERUN}))?$`),
    read: (m) => ({
      userId: m[1] as string,
      documentId: m[2] as string,
      generation: num(m[3], 1) as number,
      rerun: num(m[4], 0) as number,
    }),
  },
  {
    family: "turnVisualize",
    re: new RegExp(`^u_(${U}):visualize-turn-(${U})-(${ORD_PATTERN})(?:-r(${RERUN}))?$`),
    read: (m) => ({
      userId: m[1] as string,
      chatId: m[2] as string,
      ord: Number(m[3]),
      ...(m[4] !== undefined && { rerun: Number(m[4]) }),
    }),
  },
  {
    family: "suggestTags",
    re: new RegExp(`^u_(${U}):suggest-tags-(${U})-r(${RERUN})$`),
    read: (m) => ({ userId: m[1] as string, documentId: m[2] as string, rerun: Number(m[3]) }),
  },
  {
    family: "chatTitle",
    re: new RegExp(`^u_(${U}):chat-title-(${U})$`),
    read: (m) => ({ userId: m[1] as string, chatId: m[2] as string }),
  },
  {
    family: "conversation",
    re: new RegExp(`^u_(${U})\\.c-(${U})(?:~${GEN})?$`),
    read: (m) => ({ userId: m[1] as string, chatId: m[2] as string }),
  },
];
const LEGACY_LINEAGE: readonly Rule[] = [
  {
    family: "documentLineage",
    re: new RegExp(`^visuals-(${U})-(${U})$`),
    read: (m) => ({ userId: m[1] as string, documentId: m[2] as string }),
  },
  {
    family: "turnLineage",
    re: new RegExp(`^turnvisuals-(${U})-(${U})-(${ORD_PATTERN})$`),
    read: (m) => ({ userId: m[1] as string, chatId: m[2] as string, ord: Number(m[3]) }),
  },
];

interface OpaqueRule {
  family: IdFamily;
  re: RegExp;
  read(m: RegExpExecArray): Omit<OpaqueShape, "family">;
}
/** New format: `h_<H>` for the user, a token for the document or chat. */
const OPAQUE: readonly OpaqueRule[] = [
  {
    family: "ingest",
    re: new RegExp(`^h_(${H}):ingest-(${T})(?:\\.(${GEN_NEW}))?$`),
    read: (m) => ({
      handle: m[1] as string,
      documentToken: m[2] as string,
      generation: num(m[3], 1) as number,
    }),
  },
  {
    family: "visualize",
    re: new RegExp(`^h_(${H}):visualize-(${T})(?:\\.(${GEN_NEW}))?(?:-r(${RERUN}))?$`),
    read: (m) => ({
      handle: m[1] as string,
      documentToken: m[2] as string,
      generation: num(m[3], 1) as number,
      rerun: num(m[4], 0) as number,
    }),
  },
  {
    family: "turnVisualize",
    re: new RegExp(`^h_(${H}):visualize-turn-(${T})-(${ORD_PATTERN})(?:-r(${RERUN}))?$`),
    read: (m) => ({
      handle: m[1] as string,
      chatToken: m[2] as string,
      ord: Number(m[3]),
      ...(m[4] !== undefined && { rerun: Number(m[4]) }),
    }),
  },
  {
    family: "suggestTags",
    re: new RegExp(`^h_(${H}):suggest-tags-(${T})-r(${RERUN})$`),
    read: (m) => ({ handle: m[1] as string, documentToken: m[2] as string, rerun: Number(m[3]) }),
  },
  {
    family: "chatTitle",
    re: new RegExp(`^h_(${H}):chat-title-(${T})$`),
    read: (m) => ({ handle: m[1] as string, chatToken: m[2] as string }),
  },
  {
    family: "conversation",
    re: new RegExp(`^h_(${H})\\.c-(${T})(?:~${GEN})?$`),
    read: (m) => ({ handle: m[1] as string, chatToken: m[2] as string }),
  },
];
const OPAQUE_LINEAGE: readonly OpaqueRule[] = [
  {
    family: "documentLineage",
    re: new RegExp(`^visuals-(${H})-(${T})$`),
    read: (m) => ({ handle: m[1] as string, documentToken: m[2] as string }),
  },
  {
    family: "turnLineage",
    re: new RegExp(`^turnvisuals-(${H})-(${T})-(${ORD_PATTERN})$`),
    read: (m) => ({ handle: m[1] as string, chatToken: m[2] as string, ord: Number(m[3]) }),
  },
];

/** What an id shows without any key: an old-format id in full, a new-format id as handle plus tokens, or null. Never throws. */
export type Shape =
  | { format: "legacy"; parsed: ParsedId }
  | { format: "opaque"; shape: OpaqueShape };

function shapeIn(id: string, legacy: readonly Rule[], opaque: readonly OpaqueRule[]): Shape | null {
  for (const rule of legacy) {
    const m = rule.re.exec(id);
    if (m) {
      const read = rule.read(m);
      return {
        format: "legacy",
        parsed: { format: "legacy", family: rule.family, ...read, userId: read.userId as string },
      };
    }
  }
  for (const rule of opaque) {
    const m = rule.re.exec(id);
    if (m) return { format: "opaque", shape: { family: rule.family, ...rule.read(m) } };
  }
  return null;
}

/** The shape of an execution or conversation id. */
export const shapeOfExecution = (id: string): Shape | null => shapeIn(id, LEGACY, OPAQUE);
/** The shape of a lineage line's experience id (`visuals-...` or `turnvisuals-...`, without Loom UI's stream prefix). */
export const shapeOfLineage = (id: string): Shape | null =>
  shapeIn(id, LEGACY_LINEAGE, OPAQUE_LINEAGE);

/** The fields of an id that are in the clear in both formats: no key is needed to read them. */
export interface ClearFields {
  family: IdFamily;
  generation?: number;
  rerun?: number;
  ord?: number;
}

/** The clear fields of an execution or conversation id (family, ingest generation, run number, turn ordinal), or null. Never needs the cache. */
export function clearFieldsOf(id: string): ClearFields | null {
  const shape = shapeOfExecution(id);
  if (shape === null) return null;
  const r = shape.format === "legacy" ? shape.parsed : shape.shape;
  return {
    family: r.family,
    ...(r.generation !== undefined && { generation: r.generation }),
    ...(r.rerun !== undefined && { rerun: r.rerun }),
    ...(r.ord !== undefined && { ord: r.ord }),
  };
}

/** The family of an execution id, from its shape alone (no key): the cheap classification the fold and recovery use. */
export const familyOfExecution = (id: string): IdFamily | null => {
  const shape = shapeOfExecution(id);
  return shape === null
    ? null
    : shape.format === "legacy"
      ? shape.parsed.family
      : shape.shape.family;
};

const SUBJECT_LEGACY = new RegExp(`^u_(${U})(?::|\\.c-|$)`);
const SUBJECT_OPAQUE = new RegExp(`^h_(${H})(?::|\\.c-|$)`);
const LINEAGE_LEGACY_SUBJECT = new RegExp(
  `^(?:visuals-(${U})-${U}|turnvisuals-(${U})-${U}-${ORD_PATTERN})$`,
);
const LINEAGE_OPAQUE_SUBJECT = new RegExp(
  `^(?:visuals-(${H})-${T}|turnvisuals-(${H})-${T}-${ORD_PATTERN})$`,
);

/**
 * The erasure subject of an execution, from the id alone (no key, no cache): the user UUID for `u_<uuid>...` ids, `h_<H>` for `h_<H>...`
 * ids, the same for a lineage line, and `x:<id>` for an execution no user owns. A lineage id of another shape is "" (no subject):
 * the encrypting stores refuse to write under it.
 */
export function subjectOfId(executionId: string): string {
  if (executionId.startsWith(LINEAGE_STREAM_PREFIX)) {
    const rest = executionId.slice(LINEAGE_STREAM_PREFIX.length);
    const legacy = LINEAGE_LEGACY_SUBJECT.exec(rest);
    if (legacy) return (legacy[1] ?? legacy[2]) as string;
    const opaque = LINEAGE_OPAQUE_SUBJECT.exec(rest);
    return opaque ? `h_${(opaque[1] ?? opaque[2]) as string}` : "";
  }
  const legacy = SUBJECT_LEGACY.exec(executionId);
  if (legacy) return legacy[1] as string;
  const opaque = SUBJECT_OPAQUE.exec(executionId);
  return opaque ? `h_${opaque[1] as string}` : `x:${executionId}`;
}

/** The erasure subject of a user's new-format executions: `h_<H>`. */
export const subjectOfHandle = (handle: string): string => `h_${handle}`;

/** The handle of an `h_<H>` subject, or null. */
export const handleOfSubject = (subject: string): string | null =>
  new RegExp(`^h_(${H})$`).exec(subject)?.[1] ?? null;

/** A user id stays strict (a non-canonical one is a bug, as with the old builders): no lower-casing. */
const checkUser = (id: string): string => {
  if (!CANONICAL.test(id)) throw new RangeError("userId must be a canonical lower-case uuid");
  return id;
};
const checkUuid = (what: string, id: string): string => {
  // The old builders lower-cased a document or chat id; so do these (a mixed-case UUID is the same UUID).
  const lower = id.toLowerCase();
  if (!CANONICAL.test(lower)) throw new RangeError(`${what} must be a canonical lower-case uuid`);
  return lower;
};
const checkGeneration = (g: number): number => {
  if (!Number.isSafeInteger(g) || g < 1 || g > MAX_GENERATION)
    throw new RangeError("generation must be an integer from 1 to 999999999");
  return g;
};
const checkRerun = (n: number): number => {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_RERUN)
    throw new RangeError("rerun must be an integer from 1 to 999");
  return n;
};
const checkOrd = (ord: number): number => {
  if (!Number.isSafeInteger(ord) || ord < 1 || ord > 999_999_999_999_999)
    throw new RangeError("ord must be an integer from 1 to 999999999999999");
  return ord;
};
const within = <T extends string>(id: string): T => {
  const bytes = Buffer.byteLength(id, "utf8");
  if (bytes > MAX_EXECUTION_ID_BYTES)
    throw new RangeError(`id is ${bytes} bytes, over the ${MAX_EXECUTION_ID_BYTES}-byte limit`);
  return id as T;
};
const generationSuffix = (g: number) => (g === 1 ? "" : `.${g}`);
const rerunSuffix = (n: number | undefined) => (n === undefined ? "" : `-r${checkRerun(n)}`);

/** The old-format builders: what runs before the deploy used. Kept for reading and cancelling those runs, and for tests. */
export const legacyIds = {
  /** Any `u_<user>:<name>` id: the free-form shape Loom's `::` children and `~n` successors extend. For tests of the subject mapping; the families below are what the app ran. */
  named: (userId: string, name: string): UserExecutionId =>
    within(`u_${checkUser(userId)}:${name}`),
  ingest: (userId: string, documentId: string, generation: number): UserExecutionId =>
    within(
      `u_${checkUser(userId)}:ingest-${checkUuid("documentId", documentId)}${generationSuffix(checkGeneration(generation))}`,
    ),
  visualize: (
    userId: string,
    documentId: string,
    generation: number,
    rerun?: number,
  ): UserExecutionId =>
    within(
      `u_${checkUser(userId)}:visualize-${checkUuid("documentId", documentId)}${generationSuffix(checkGeneration(generation))}${rerunSuffix(rerun)}`,
    ),
  suggestTags: (userId: string, documentId: string, run: number): UserExecutionId =>
    within(
      `u_${checkUser(userId)}:suggest-tags-${checkUuid("documentId", documentId)}-r${checkRerun(run)}`,
    ),
  turnVisualize: (userId: string, chatId: string, ord: number, rerun?: number): UserExecutionId =>
    within(
      `u_${checkUser(userId)}:visualize-turn-${checkUuid("chatId", chatId)}-${checkOrd(ord)}${rerunSuffix(rerun)}`,
    ),
  chatTitle: (userId: string, chatId: string): UserExecutionId =>
    within(`u_${checkUser(userId)}:chat-title-${checkUuid("chatId", chatId)}`),
  conversation: (userId: string, chatId: string): ChatConversationId => {
    const id = `u_${checkUser(userId)}.c-${checkUuid("chatId", chatId)}`;
    if (!isValidConversationId(id)) throw new RangeError("not a valid Loom conversation id");
    return id as ChatConversationId;
  },
  documentLineage: (userId: string, documentId: string): string =>
    `visuals-${checkUser(userId)}-${checkUuid("documentId", documentId)}`,
  turnLineage: (userId: string, chatId: string, ord: number): string =>
    `turnvisuals-${checkUser(userId)}-${checkUuid("chatId", chatId)}-${checkOrd(ord)}`,
};

/** One user's builders, new format. Make one with `OpaqueIds.ensureUser` (it has fetched the key and the handle). Pure and synchronous. */
export class UserIds {
  constructor(
    readonly userId: string,
    readonly handle: string,
    private readonly key: IdKey,
  ) {}

  private doc = (id: string) => sealToken(this.key, "doc", checkUuid("documentId", id));
  private chat = (id: string) => sealToken(this.key, "chat", checkUuid("chatId", id));
  private prefix = () => `h_${this.handle}`;

  ingest(documentId: string, generation: number): UserExecutionId {
    return within(
      `${this.prefix()}:ingest-${this.doc(documentId)}${generationSuffix(checkGeneration(generation))}`,
    );
  }
  visualize(documentId: string, generation: number, rerun?: number): UserExecutionId {
    return within(
      `${this.prefix()}:visualize-${this.doc(documentId)}${generationSuffix(checkGeneration(generation))}${rerunSuffix(rerun)}`,
    );
  }
  suggestTags(documentId: string, run: number): UserExecutionId {
    return within(`${this.prefix()}:suggest-tags-${this.doc(documentId)}-r${checkRerun(run)}`);
  }
  turnVisualize(chatId: string, ord: number, rerun?: number): UserExecutionId {
    return within(
      `${this.prefix()}:visualize-turn-${this.chat(chatId)}-${checkOrd(ord)}${rerunSuffix(rerun)}`,
    );
  }
  chatTitle(chatId: string): UserExecutionId {
    return within(`${this.prefix()}:chat-title-${this.chat(chatId)}`);
  }
  conversation(chatId: string): ChatConversationId {
    const id = `${this.prefix()}.c-${this.chat(chatId)}`;
    if (!isValidConversationId(id)) throw new RangeError("not a valid Loom conversation id");
    return id as ChatConversationId;
  }
  documentLineage(documentId: string): string {
    return `visuals-${this.handle}-${this.doc(documentId)}`;
  }
  turnLineage(chatId: string, ord: number): string {
    return `turnvisuals-${this.handle}-${this.chat(chatId)}-${checkOrd(ord)}`;
  }
}

/** The handle of a new-format execution, conversation or lineage id (with or without Loom's lineage stream prefix), or null. */
export function handleOfAnyId(id: string): string | null {
  const bare = id.startsWith(LINEAGE_STREAM_PREFIX) ? id.slice(LINEAGE_STREAM_PREFIX.length) : id;
  const shape = shapeOfExecution(bare) ?? shapeOfLineage(bare);
  return shape?.format === "opaque" ? shape.shape.handle : null;
}
