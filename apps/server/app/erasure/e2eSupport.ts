import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { accountKey, hashPassword } from "@docmind/auth";
import {
  ChatSessionDto,
  ErasureStatusResponse,
  type UploadDocumentResponse,
} from "@docmind/contracts";
import type { EventEnvelope } from "@loom/core";
import { isKeyUnavailable, isPayloadShredded } from "@loom/event-runtime";
import type { Pool } from "pg";
import { expect, vi } from "vitest";
import { DOC_ASSISTANT_GK_PROMPT, DOC_ASSISTANT_PROMPT } from "../chats/agent";
import {
  DOC,
  SENTENCE,
  SIG,
  collectUntil,
  hasToolResult,
  isReply,
  searchTurn,
} from "../chats/e2eSupport";
import { assertNoPlaintext } from "../chats/eventLogProof";
import { CHAT_TOOL_DEFS } from "../chats/tools";
import type { IngestStack } from "../documents/ingestStack";
import { STEP_ORDER } from "./eraser";

/** The password `startIngestStack().signUpAndLogIn` uses. */
export const PASSWORD = "correct horse battery";
export const QUESTION = "When is payment due?";
/** Fixed texts of the fake model and the fixed document (12+ characters) that must never be readable once the user is erased. */
export const SECRETS = [
  QUESTION,
  "Payment is due",
  "I should look for the payment terms",
  SENTENCE,
  SIG,
  "Late payment accrues", // the rest of the passage
];

const tag = () => randomBytes(6).toString("hex");

export interface Seeded {
  email: string;
  cookie: string;
  userId: string;
  tenantId: string;
  documentId: string;
  passageId: string;
  chatId: string;
  /** Strings only this user wrote: in the document text, the file name, the question, the answer and the title. */
  sentinels: string[];
  /** The auto title (it carries a sentinel). */
  title: string;
  /** Every Loom execution that appeared while the user was seeded (found by comparing the log before and after). */
  executions: string[];
}

/** The two throttle counters keyed by a hash of an email (the hash is all the table holds of it). */
export const emailHash = (email: string): string =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
export const throttleKeys = (email: string): string[] => [
  accountKey("login", email),
  accountKey("signup", email),
];

/**
 * A session for an existing account. Rejects with "login failed <status>" when the server refuses. Only the per-IP
 * counters are cleared (the suite logs in from one address more often than they allow); the per-email counters are
 * left as the routes keep them.
 */
export async function loginAs(
  st: IngestStack,
  email: string,
  password = PASSWORD,
): Promise<string> {
  await st.db.owner.query("DELETE FROM auth_throttle WHERE key LIKE '%-ip:%'");
  const res = await fetch(`${st.base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed ${res.status}`);
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

/**
 * A second user inside an existing tenant. Sign-up always makes a personal tenant, so the row goes in the way
 * the owner role would add it.
 */
export async function addUserToTenant(st: IngestStack, tenantId: string, email: string) {
  const userId = randomUUID();
  await st.db.owner.query(
    "INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, $4)",
    [userId, tenantId, email, await hashPassword(PASSWORD)],
  );
  return { cookie: await loginAs(st, email), userId, tenantId };
}

/** Every execution id in the raw log. */
async function executionIds(st: IngestStack): Promise<string[]> {
  const list = st.durable.raw.eventStore.listExecutions;
  if (!list) throw new Error("the raw event store cannot list executions");
  return list.call(st.durable.raw.eventStore);
}

/**
 * Uploads a document and waits until it is ready, then holds one cited, reasoned chat turn and waits for its
 * auto title. Everything D8 lists as "before". Document text, file name, question, answer and title each carry a
 * sentinel that only this user wrote.
 */
export async function seedUser(
  st: IngestStack,
  who: { cookie: string; userId: string; tenantId: string },
  email: string,
): Promise<Seeded> {
  const claude = st.claude;
  if (!claude) throw new Error("the stack has no fake LLM provider");
  const [inDoc, inFile, inAsk, inAnswer, inTitle] = [
    `sentinel-doc-${tag()}`,
    `sentinel-file-${tag()}`,
    `sentinel-ask-${tag()}`,
    `sentinel-answer-${tag()}`,
    `sentinel-title-${tag()}`,
  ];
  const title = `Title ${inTitle}`;
  const before = new Set(await executionIds(st));
  const events = await st.events(who.cookie);
  const up = await st.upload(who.cookie, `${inFile}.txt`, Buffer.from(`${DOC} ${inDoc}.`));
  expect(up.status).toBe(201);
  const documentId = ((await up.json()) as UploadDocumentResponse).document.id;
  const seen = await st.until(events, documentId, (s) => s === "ready" || s === "failed");
  events.close();
  expect(seen.at(-1)?.status).toBe("ready");
  const passageId = (
    await st.db.owner.query("SELECT id FROM chunks WHERE document_id = $1", [documentId])
  ).rows[0].id as string;
  claude.reply((body) => {
    if (body.model === "title-model") return { text: title };
    if (!hasToolResult(body)) return searchTurn();
    return {
      stream: {
        steps: [
          { text: "Payment is due " },
          { text: `within 30 days [[${passageId}]]. ${inAnswer}` },
          { stop: "end_turn" },
        ],
      },
    };
  });
  const chat = ChatSessionDto.parse(
    await (await st.chatReq(who.cookie, "POST", "/api/chats", {})).json(),
  );
  const stream = await st.openChat(who.cookie, chat.id);
  try {
    const sent = await st.chatReq(who.cookie, "POST", `/api/chats/${chat.id}/messages`, {
      text: `${QUESTION} ${inAsk}`,
    });
    expect(sent.status).toBe(202);
    await collectUntil(stream, isReply);
  } finally {
    stream.close();
  }
  await st.composed.activity.drain();
  await vi.waitFor(
    async () => {
      const one = ChatSessionDto.parse(
        await (await st.chatReq(who.cookie, "GET", `/api/chats/${chat.id}`)).json(),
      );
      expect(one.title).toBe(title);
    },
    { timeout: 20_000 }, // the title flow is a durable execution with no hook to await
  );
  const executions = (await executionIds(st)).filter((id) => !before.has(id));
  expect(executions.length).toBeGreaterThanOrEqual(3); // conversation, ingest, title
  return {
    email,
    ...who,
    documentId,
    passageId,
    chatId: chat.id,
    sentinels: [inDoc, inFile, inAsk, inAnswer, inTitle],
    title,
    executions,
  };
}

export const eraseMe = (st: IngestStack, cookie: string, password = PASSWORD) =>
  fetch(`${st.base}/api/me`, {
    method: "DELETE",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });

/**
 * The state a receipt reads, as an anonymous caller (no cookie): `{ status: 200, state }`, or `{ status }` for a 404.
 * Every answer must be `no-store`.
 */
export async function receiptState(
  st: IngestStack,
  receipt: string,
): Promise<{ status: number; state?: string }> {
  const res = await fetch(`${st.base}/api/erasure/${receipt}`);
  expect(res.headers.get("cache-control")).toBe("no-store");
  if (res.status !== 200) return { status: res.status };
  return { status: 200, state: ErasureStatusResponse.parse(await res.json()).state };
}

/** Resolves when the user's request is `done`. */
export const waitErased = (st: IngestStack, userId: string, timeout = 90_000) =>
  vi.waitFor(
    async () => {
      const { rows } = await st.db.owner.query(
        "SELECT state FROM erasure_requests WHERE user_id = $1",
        [userId],
      );
      expect(rows[0]?.state).toBe("done");
    },
    { timeout, interval: 100 },
  );

// ---------------------------------------------------------------------------------------------------------------
// The scan: every column of every table DocMind or Loom writes, looked at as text.
// ---------------------------------------------------------------------------------------------------------------

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const MIN_NEEDLE = 8; // a shorter needle proves nothing and can occur by chance (an empty one matches everything)

export interface Hit {
  /** `schema.table` */
  table: string;
  column: string;
  /** Every row whose column holds a needle, as JSON. */
  rows: Record<string, unknown>[];
}

/**
 * Every column of every base table outside `pg_catalog` and `information_schema` (all schemas found through the
 * catalog, `public` and `loom` today, cross-checked against pg_class), cast to text (`json`, `jsonb`, arrays, `citext` and `uuid` as their text; `bytea` both as
 * its hex text and as escaped bytes), and searched for each needle as a substring. Read as the owner role, so row-level
 * security hides nothing. Skips nothing: a column that cannot be searched is an error.
 */
export async function scanTables(
  owner: Pool,
  needles: readonly string[],
): Promise<{ hits: Hit[]; scanned: string[] }> {
  if (needles.length === 0 || needles.some((n) => n.length < MIN_NEEDLE))
    throw new Error(`every needle must be at least ${MIN_NEEDLE} characters`);
  // The scan must see every row and every table: it runs as the superuser of the test URL, and the catalog list is
  // cross-checked against pg_class (information_schema shows only what the role may access).
  const me = await owner.query(
    "SELECT current_user AS name, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super",
  );
  const wanted = decodeURIComponent(
    new URL(process.env.DOCMIND_TEST_PG_URL ?? "postgres://none").username,
  );
  if (me.rows[0].super !== true || me.rows[0].name !== wanted)
    throw new Error(
      "the scan must run as the superuser of DOCMIND_TEST_PG_URL, or it may not see every row",
    );
  const { rows: columns } = await owner.query(
    `SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c, c.udt_name AS u
       FROM information_schema.columns c
       JOIN information_schema.tables x
         ON x.table_schema = c.table_schema AND x.table_name = c.table_name
      WHERE x.table_type = 'BASE TABLE'
        AND c.table_schema NOT IN ('pg_catalog', 'information_schema')
        AND c.table_schema NOT LIKE 'pg\_toast%' AND c.table_schema NOT LIKE 'pg\_temp%'
      ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
  );
  const catalog = await owner.query(
    `SELECT count(*)::int AS n FROM pg_class k JOIN pg_namespace n ON n.oid = k.relnamespace
      WHERE k.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp%'`,
  );
  const tables = new Set((columns as { s: string; t: string }[]).map((r) => `${r.s}.${r.t}`));
  if (tables.size !== catalog.rows[0].n)
    throw new Error(
      "the catalog lists tables that information_schema does not: the scan would skip them",
    );
  const hits: Hit[] = [];
  const scanned: string[] = [];
  for (const { s, t, c, u } of columns as { s: string; t: string; c: string; u: string }[]) {
    const col = `x.${quote(c)}`;
    const probes = [`strpos(lower(${col}::text), lower(n)) > 0`];
    if (u === "bytea") probes.push(`strpos(lower(encode(${col}, 'escape')), lower(n)) > 0`);
    const table = `${s}.${t}`;
    scanned.push(`${table}.${c}`);
    const found = await owner.query(
      `SELECT to_jsonb(x) AS row FROM ${quote(s)}.${quote(t)} x
        WHERE EXISTS (SELECT 1 FROM unnest($1::text[]) AS n WHERE ${probes.join(" OR ")})`,
      [needles],
    );
    if (found.rowCount) hits.push({ table, column: c, rows: found.rows.map((r) => r.row) });
  }
  return { hits, scanned };
}

/** Whom a scan is about. */
export interface Who {
  userId: string;
  tenantId: string;
  email: string;
  sentinels: readonly string[];
}

type Row = Record<string, unknown>;

/**
 * The by-design residue of an erasure (D7), as an allowlist of `schema.table.column` with the reason and the exact
 * shape the rows must have. A hit on a column that is not listed, or on a row that does not have the shape, fails.
 */
interface Allowed {
  table: string;
  column: string;
  reason: string;
  ok(row: Row, who: Who): boolean;
}

const isUserExecution = (id: unknown, who: Who) =>
  typeof id === "string" && id.startsWith(`u_${who.userId}`);

/** The user's own Loom executions: `u_<user>...` (a chat is `.c-<chat>`, a flow `:<name>`). */
const ownExecution = (row: Row, who: Who) => isUserExecution(row.execution_id, who);
/** A row that carries no content of the user: no sentinel and not the email. */
const noContent = (row: Row, who: Who) => {
  const text = JSON.stringify(row);
  return ![...who.sentinels, who.email].some((n) => text.includes(n));
};
const sealed = (v: unknown) =>
  typeof v === "object" &&
  v !== null &&
  (v as { __loomEnc?: unknown }).__loomEnc === "loom/aes-256-gcm";

const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID_VALUE = new RegExp(`^(${UUID_RE}|u_${UUID_RE}([:.~][A-Za-z0-9_.:~-]*)?)$`);
const oneOf = (...values: string[]): RegExp =>
  new RegExp(`^(${values.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`);
const exactly = (values: readonly string[]) => ({ test: (v: string) => values.includes(v) });
type Check = { test(value: string): boolean };
const TOOLS = CHAT_TOOL_DEFS as readonly { name: string; description: string }[];

/**
 * The only plaintext strings a user's own event payload may hold, by key: ids (the flow input, the inbox sender, the
 * erase intent), and fixed tokens or texts the code defines (a flow hash, step and decision ids, the inbox topic, the
 * system prompts and the tool definitions the model call records, the enums of the log's own bookkeeping). The prompts
 * and tool texts are taken from the code, not from what the log holds. Anything else is content, or a place content
 * could hide, and fails.
 */
const PAYLOAD_STRINGS: Record<string, Check> = {
  userId: ID_VALUE,
  tenantId: ID_VALUE,
  documentId: ID_VALUE,
  chatId: ID_VALUE,
  subjectId: ID_VALUE,
  conversationId: ID_VALUE,
  actor: ID_VALUE,
  tenant: ID_VALUE,
  flowHash: /^fnv1a:[0-9a-f]{8}$/,
  stepId: /^(ingest-[a-z]+|chat-title|conv#[a-z0-9#:]+)$/,
  decisionId: /^conv#[a-z0-9#:]+$/,
  innerSteps: /^conv#[a-z0-9#:]+$/,
  topic: /^conversation:turn$/,
  waitId: /^#\d+$/,
  messageId: /^([0-9a-f]{32,64}|[0-9a-f-]{36})$/,
  outcome: oneOf("done", "failed", "titled", "skipped"),
  on: oneOf("__loom_waits__"),
  kind: oneOf("inbox", "closed", "dropped"),
  reason: oneOf("erased"), // the fixed cancel reason of the eraser (wire.ts)
  source: oneOf(
    "conversation-access",
    "conversation-budget",
    "conversation-record",
    "agent-abort",
    "agent-outcome",
  ),
  role: oneOf("user", "assistant"),
  status: oneOf("complete", "interrupted", "failed"),
  stopReason: oneOf("tool_use", "end_turn", "max_tokens", "stop_sequence"),
  provider: oneOf("anthropic"),
  model: /^(claude-[a-z0-9.-]+|ollama\/[a-z0-9.:-]+|none)$/,
  id: /^toolu_\d+$/,
  origin: oneOf("document"),
  // the tool definitions of the model call (from CHAT_TOOL_DEFS) and their JSON schema vocabulary
  name: exactly(TOOLS.map((t) => t.name)),
  description: exactly(TOOLS.map((t) => t.description)),
  system: exactly([DOC_ASSISTANT_PROMPT, DOC_ASSISTANT_GK_PROMPT]),
  type: oneOf("object", "integer", "string", "array", "number", "boolean"),
  required: oneOf("query", "passageId", "documentId", "k", "kind"),
  enum: oneOf("structure", "reference", "entity", "similar", "section", "neighbours"),
  format: oneOf("uuid"),
};

/** The keys (never the values) under which a payload holds a string that is neither an envelope nor a listed id or token. */
export function unlistedStrings(value: unknown, key = ""): string[] {
  if (typeof value === "string") return PAYLOAD_STRINGS[key]?.test(value) === true ? [] : [key];
  if (value === null || typeof value !== "object" || sealed(value)) return [];
  return Object.entries(value).flatMap(([k, v]) =>
    unlistedStrings(v, Array.isArray(value) ? key : k),
  );
}

/**
 * A payload is acceptable residue only if it is a sealed (or shredded) envelope, or a plaintext object whose string
 * leaves are all listed ids or tokens (numbers, booleans and null are fine). Exported for its unit test.
 */
export function payloadIsIdsOnly(value: unknown, key = ""): boolean {
  if (value === null || typeof value === "number" || typeof value === "boolean") return true;
  if (typeof value === "string") return PAYLOAD_STRINGS[key]?.test(value) === true;
  if (Array.isArray(value)) return value.every((v) => payloadIsIdsOnly(v, key));
  if (typeof value === "object") {
    if (sealed(value)) return true;
    return Object.entries(value).every(([k, v]) => payloadIsIdsOnly(v, k));
  }
  return false;
}

const COLUMN_TOKEN = /^[A-Za-z0-9_.:~#-]{1,200}$/;
const CIPHER_ID = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,63}$/;
const SEAL_PATH = /^[A-Z][A-Z0-9_]{2,63}(\.[A-Za-z0-9_]{1,64}(\[\])?){0,8}$/;
const EVENT_TYPE = /^[A-Z][A-Z0-9_]{2,63}$/;
/** The operational keys Loom stamps on an envelope's metadata, each with the only value shape it may have. */
/** A generous bound on the entries one seal marker may list (real markers list a handful of paths). */
const MAX_COVERS = 256;
/** Loom's control events carry an empty workflow id; no other event may. */
const EMPTY_WORKFLOW_OK = new Set(["ERASURE_PENDING", "PAYLOAD_SHREDDED"]);
const METADATA: Record<string, (v: unknown) => boolean> = {
  kernel: (v) => v === true,
  fence: (v) => Number.isSafeInteger(v) && (v as number) >= 0,
  computeTarget: (v) => typeof v === "string" && COLUMN_TOKEN.test(v),
  // The seal marker (`SealMarker`): `{ v: 1, cipher, covers }`, the cipher id and the `EVENT_TYPE.field.path` entries it sealed.
  seal: (v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const m = v as Record<string, unknown>;
    return (
      Object.keys(m).sort().join() === "cipher,covers,v" &&
      m.v === 1 &&
      typeof m.cipher === "string" &&
      CIPHER_ID.test(m.cipher) &&
      Array.isArray(m.covers) &&
      m.covers.length <= MAX_COVERS &&
      m.covers.every((c) => typeof c === "string" && SEAL_PATH.test(c))
    );
  },
};

/**
 * The plaintext columns of a raw event other than its payload, judged by shape: ids and fixed tokens (no whitespace, no
 * quotes, at most 200 characters), `eventType` upper snake case, non-negative integers for `sequence` and `timestamp`, and
 * metadata that is null or only Loom's operational keys with their value shapes. Returns the names of the offending
 * columns (`metadata.<key>` for a key); never a value.
 */
export function eventColumnProblems(e: {
  id: unknown;
  workflowId: unknown;
  executionId: unknown;
  eventType: unknown;
  sequence: unknown;
  timestamp: unknown;
  metadata?: unknown;
}): string[] {
  const bad: string[] = [];
  const token = (name: string, v: unknown) => {
    if (typeof v !== "string" || !COLUMN_TOKEN.test(v)) bad.push(name);
  };
  token("id", e.id);
  if (e.workflowId !== "" || typeof e.eventType !== "string" || !EMPTY_WORKFLOW_OK.has(e.eventType))
    token("workflowId", e.workflowId);
  token("executionId", e.executionId);
  if (typeof e.eventType !== "string" || !EVENT_TYPE.test(e.eventType)) bad.push("eventType");
  for (const name of ["sequence", "timestamp"] as const) {
    const v = e[name];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) bad.push(name);
  }
  const m = e.metadata;
  if (m !== undefined && m !== null) {
    if (typeof m !== "object" || Array.isArray(m)) bad.push("metadata");
    else
      for (const [k, v] of Object.entries(m))
        if (!Object.hasOwn(METADATA, k) || METADATA[k]?.(v) !== true) bad.push(`metadata.${k}`);
  }
  return bad;
}

/** Loom's plaintext control stream of parked shreds (never compacted, never cleared) and this user's rows in it. */
export async function intentRows(st: IngestStack, userId: string): Promise<EventEnvelope[]> {
  const events = await st.durable.raw.eventStore.read("__loom_erasure__");
  return events.filter(
    (e) =>
      e.eventType === "ERASURE_PENDING" &&
      (e.payload as { subjectId?: unknown } | null)?.subjectId === userId,
  );
}

const ALLOWED: Allowed[] = [
  // D7: Loom execution ids are plaintext and carry the user's id (and the document or chat id), so every row of the
  // user's own executions names them. The content of those rows is sealed under the destroyed key; here only that the
  // row is the user's own and holds no content. (`assertLogUnreadable` checks the tombstone and the sealing per execution.)
  ...["id", "execution_id"].map((column) => ({
    table: "loom.events",
    column,
    reason:
      "D7: the plaintext execution id (and envelope id derived from it) of the user's own execution",
    ok: (row: Row, who: Who) => ownExecution(row, who) && noContent(row, who),
  })),
  {
    table: "loom.events",
    column: "payload",
    reason:
      "ids only: the flow input (userId, tenantId, documentId, chatId), the sender, the conversation id and the erase intent/tombstone of the user's own executions; every other leaf is a sealed envelope, a number or a listed token",
    ok: (row, who) =>
      ownExecution(row, who) && noContent(row, who) && payloadIsIdsOnly(row.payload),
  },
  {
    table: "loom.events",
    column: "payload",
    reason:
      "F26: Loom's `__loom_erasure__` control stream keeps ERASURE_PENDING { subjectId } of a parked shred",
    ok: (row, who) =>
      row.execution_id === "__loom_erasure__" &&
      row.event_type === "ERASURE_PENDING" &&
      (row.payload as { subjectId?: unknown } | null)?.subjectId === who.userId &&
      payloadIsIdsOnly(row.payload) &&
      noContent(row, who),
  },
  {
    table: "loom.fences",
    column: "execution_id",
    reason: "D7: the fence counter of the user's own execution",
    ok: (row, who) => ownExecution(row, who),
  },
  {
    table: "loom.snapshots",
    column: "execution_id",
    reason:
      "D7: a checkpoint of the user's own execution, its state a sealed envelope under the destroyed key",
    ok: (row, who) => ownExecution(row, who) && sealed(row.state) && noContent(row, who),
  },
  {
    table: "public.data_keys",
    column: "subject_id",
    reason: "D7: the key tombstone (no key material, destroyed_at set)",
    ok: (row, who) =>
      row.subject_id === who.userId && row.wrapped_dek === null && row.destroyed_at !== null,
  },
  {
    table: "public.erasure_requests",
    column: "user_id",
    reason: "the audit row of the erasure: ids, steps and times",
    ok: (row, who) => row.user_id === who.userId && row.state === "done" && noContent(row, who),
  },
  {
    table: "public.erasure_requests",
    column: "tenant_id",
    reason: "the audit row of the erasure: ids, steps and times",
    ok: (row, who) => row.user_id === who.userId && row.state === "done" && noContent(row, who),
  },
  ...["execution_id", "scope", "app_key"].map((column) => ({
    table: "public.read_model_state",
    column,
    reason: "D7: a read-model tombstone (state NULL, erased) keeps the key of the row it replaced",
    ok: (row: Row, who: Who) => row.state === null && row.erased === true && noContent(row, who),
  })),
];

const key = (h: { table: string; column: string }) => `${h.table}.${h.column}`;

/** The hits that are not by-design residue, as `table.column` (never a value). */
export function unexpected(hits: readonly Hit[], who: Who): string[] {
  const bad = new Set<string>();
  for (const h of hits) {
    const allowed = ALLOWED.filter((a) => a.table === h.table && a.column === h.column);
    for (const row of h.rows) if (!allowed.some((a) => a.ok(row, who))) bad.add(key(h));
  }
  return [...bad];
}

/**
 * Everything about a user that must be nowhere: sentinels, ids, and (unless an account took it over) the email. Not the
 * hash of the email: a failed login for the dead address is counted like any other, under that hash.
 */
export function needlesOf(
  gone: Seeded,
  opts: { tenantGone?: boolean; emailReused?: boolean } = {},
): string[] {
  return [
    ...gone.sentinels,
    gone.userId,
    gone.documentId,
    gone.chatId,
    gone.passageId,
    ...(opts.tenantGone ? [gone.tenantId] : []),
    ...(opts.emailReused ? [] : [gone.email]),
  ];
}

/** `table.column` of every column holding any needle, with no allowance at all (the "before" view, and the email after the 202). */
export async function namingColumns(owner: Pool, needles: readonly string[]): Promise<string[]> {
  const { hits } = await scanTables(owner, needles);
  return hits.map(key);
}

// ---------------------------------------------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------------------------------------------

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Captures every console method. `assertClean` fails on any UUID or any listed secret; it never prints the output. */
export function captureConsole() {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
  const text = () => JSON.stringify(spies.flatMap((s) => s.mock.calls));
  return {
    assertClean(secrets: readonly string[]) {
      const out = text();
      expect(UUID_ANYWHERE.test(out)).toBe(false);
      expect(secrets.filter((s) => s.length > 0 && out.includes(s)).length).toBe(0);
    },
    restore() {
      for (const s of spies) s.mockRestore();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------------------------------------------

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/**
 * The whole blob root: no path (directory or file) names the user, the document or (when it is gone) the tenant,
 * and no file holds a sentinel or any of those ids.
 */
export function assertBlobsGone(st: IngestStack, gone: Seeded, tenantGone: boolean): void {
  const names = [gone.userId, gone.documentId, ...(tenantGone ? [gone.tenantId] : [])];
  const everything: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      everything.push(path);
      if (e.isDirectory()) walk(path);
    }
  };
  if (existsSync(st.root)) walk(st.root);
  const paths = everything.map((p) => relative(st.root, p));
  expect(paths.filter((p) => names.some((n) => p.includes(n)))).toEqual([]);
  const contents = filesUnder(st.root).map((f) => readFileSync(f).toString("latin1"));
  const needles = [...gone.sentinels, ...names];
  expect(contents.filter((c) => needles.some((n) => c.includes(n))).length).toBe(0);
}

// ---------------------------------------------------------------------------------------------------------------
// The Loom log
// ---------------------------------------------------------------------------------------------------------------

/**
 * Every execution the user's activity created (recorded when it was seeded) plus any other whose id names the user:
 * - it must name the user (otherwise it is keyed outside the user's subject and no erasure can reach it);
 * - if it still has events (the executions recorded before the erasure, and any other that names the user, afterwards),
 *   the raw log holds no sentinel or fixed secret in the clear, it carries the shred tombstone, and EVERY payload is an
 *   envelope, a tombstone or only listed ids and tokens (`payloadIsIdsOnly`, whether or not the row names a needle);
 * - per execution: with sealed payloads, reading it through the decrypting store is refused as shredded or
 *   key-unavailable; without, it shows no secret.
 * The sealed snapshot of every execution is `null` or refused the same way.
 */
export async function assertLogUnreadable(st: IngestStack, gone: Seeded): Promise<void> {
  const raw = st.durable.raw.eventStore;
  const ids = [
    ...new Set([
      ...gone.executions,
      ...(await executionIds(st)).filter((id) => id.includes(gone.userId)),
    ]),
  ];
  expect(gone.executions.length).toBeGreaterThanOrEqual(3);
  const secrets = [...SECRETS, ...gone.sentinels, gone.title];
  for (const id of ids) {
    expect(id.includes(gone.userId)).toBe(true); // keyed outside the user's subject: unshreddable
    const events = await raw.read(id);
    if (events.length === 0) continue; // gone altogether (an inbox stream retired with its conversation)
    assertNoPlaintext(events, secrets);
    // The columns beside the payload (ids, workflow, type, sequence, timestamp, metadata): shape only, so a new key that
    // carried content would fail here rather than pass because it holds no known sentinel.
    expect(
      events.flatMap((e) => eventColumnProblems(e).map((column) => `${e.eventType}:${column}`)),
    ).toEqual([]);
    expect(events.some((e) => e.eventType === "PAYLOAD_SHREDDED")).toBe(true);
    // Every payload of the execution, needle or not: a sealed or shredded envelope, a tombstone, or listed ids/tokens.
    expect(
      events.flatMap((e) => unlistedStrings(e.payload).map((key) => `${e.eventType}:${key}`)),
    ).toEqual([]);
    const sealedPayloads = JSON.stringify(events).includes("__loomEnc");
    try {
      const opened = await st.durable.sealed.eventStore.read(id);
      expect(sealedPayloads).toBe(false); // an execution with sealed payloads must refuse to open
      assertNoPlaintext(opened, secrets);
    } catch (err) {
      expect(sealedPayloads).toBe(true);
      expect(isPayloadShredded(err) || isKeyUnavailable(err)).toBe(true);
    }
    const snapshot = await st.durable.sealed.snapshotStore
      .loadLatest(id)
      .catch((err: unknown) => err);
    if (snapshot !== null)
      expect(isPayloadShredded(snapshot) || isKeyUnavailable(snapshot)).toBe(true);
  }
}

/** Every claim of D8's "after" list, for one erased user. */
export async function assertErased(
  st: IngestStack,
  gone: Seeded,
  opts: { tenantGone: boolean; tombstones?: boolean; emailReused?: boolean },
  /** Sentinels the test wrote after seeding (a later question, say). */
  more: readonly string[] = [],
): Promise<void> {
  const { db, keys } = st;
  const user: Seeded = { ...gone, sentinels: [...gone.sentinels, ...more] };
  const who: Who = {
    userId: user.userId,
    tenantId: user.tenantId,
    email: user.email,
    sentinels: user.sentinels,
  };

  // 1. Nothing names the user, anywhere: every column of every table in every schema, as text, for the sentinels, the
  //    ids and the email, except the by-design residue (and that must have its exact shape).
  const { hits, scanned } = await scanTables(
    db.owner,
    needlesOf(user, { tenantGone: opts.tenantGone, emailReused: opts.emailReused === true }),
  );
  for (const table of ["public.users", "public.read_model_state", "loom.events", "loom.fences"])
    expect(scanned.some((c) => c.startsWith(`${table}.`))).toBe(true); // the scan is not blind
  expect(unexpected(hits, who)).toEqual([]);

  // 2. The read models: the user's tombstones are really there (rows that name the user are judged by the scan).
  if (opts.tombstones !== false) {
    const tomb = await db.owner.query(
      "SELECT DISTINCT model_id FROM read_model_state WHERE starts_with(execution_id, $1) AND erased AND state IS NULL",
      [`u_${user.userId}`],
    );
    expect(tomb.rows.map((r) => r.model_id).sort()).toEqual(["chat-activity", "ingest-status"]);
  }

  // 3. The key: destroyed, remembered as destroyed, and the tombstone row holds no key material.
  expect(await keys.wasDestroyed(user.userId)).toBe(true);
  expect(await keys.get(user.userId)).toBeNull();
  const key = await db.owner.query(
    "SELECT wrapped_dek IS NULL AS no_key, destroyed_at IS NOT NULL AS gone FROM data_keys WHERE subject_id = $1",
    [user.userId],
  );
  expect(key.rows).toEqual([{ no_key: true, gone: true }]);

  // 4. The whole blob root.
  assertBlobsGone(st, user, opts.tenantGone);

  // 5. The log: nothing readable, and every execution the user created is tombstoned.
  await assertLogUnreadable(st, gone);

  // 6. The audit row: one, done, every step recorded in order, ids and times only.
  const audit = await db.owner.query(
    "SELECT state, steps, completed_at IS NOT NULL AS completed FROM erasure_requests WHERE user_id = $1",
    [user.userId],
  );
  expect(audit.rows).toEqual([{ state: "done", steps: [...STEP_ORDER], completed: true }]);

  // 7. The tenant: gone with its last user, kept while anyone is left.
  const tenant = await db.owner.query("SELECT count(*)::int AS n FROM tenants WHERE id = $1", [
    user.tenantId,
  ]);
  expect(tenant.rows[0].n).toBe(opts.tenantGone ? 0 : 1);
}
