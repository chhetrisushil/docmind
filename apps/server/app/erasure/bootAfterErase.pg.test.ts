import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { RECORD_SOURCE } from "@loom/conversation";
import { type EventEnvelope, projection$ } from "@loom/core";
import { PayloadShreddedError, isShredded } from "@loom/plugin-crypto";
import { ReadModelService } from "@loom/plugin-read-model";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHAT_ACTIVITY_MODEL,
  ChatActivity,
  type ChatActivityState,
  INITIAL_ACTIVITY,
  activityHandlers,
  chatKeyOf,
  chatScopeOf,
} from "../chats/activity";
import { chatConversationId } from "../chats/ids";
import { migrate, setAppRolePassword, setRolePassword } from "../db/migrate";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { InMemoryProgressBus } from "../documents/progress";
import { IngestStatus } from "../status/ingestStatus";
import { INGEST_STATUS_MODEL } from "../status/model";
import { pgStatusWriter } from "../status/pgStores";
import { flowSteps, statusSensitive } from "../status/wire";
import { type DurableStorage, createDurableStorage } from "../storage";
import { executionIdFor } from "../subject";
import { userShredder } from "./compliance";
import { tolerantSource } from "./tolerantSource";

describe.skipIf(!PG_URL)("read-model boot over an erased user (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let pool: Pool;
  let keys: PostgresKeyStore;
  let durable: DurableStorage;
  const [A, B] = [randomUUID(), randomUUID()];
  const [chatA, chatB] = [chatConversationId(A, randomUUID()), chatConversationId(B, randomUUID())];

  const [docA, docB] = [randomUUID(), randomUUID()];
  const [ingA, ingB] = [executionIdFor(A, `ingest-${docA}`), executionIdFor(B, `ingest-${docB}`)];

  const event = (
    executionId: string,
    sequence: number,
    eventType: string,
    payload: unknown,
  ): EventEnvelope => ({
    id: randomUUID(),
    workflowId: "doc-chat",
    executionId,
    eventType,
    sequence,
    timestamp: 1_000 + sequence,
    payload,
  });
  const record = (id: string, sequence: number, role: "user" | "reply", text: string) =>
    event(id, sequence, "DECISION_RECORDED", {
      decisionId: `conv#o1:${role}`,
      source: RECORD_SOURCE,
      choice: {
        turn: 1,
        role: role === "reply" ? "assistant" : "user",
        status: "complete",
        ord: 1,
        text,
      },
    });

  const writer = () => pgStatusWriter(durable.pool);
  const sensitive = () => statusSensitive(flowSteps(), durable.sealed.eventStore);
  const fold = () =>
    tolerantSource({ raw: durable.raw.eventStore, keys, strict: durable.sealed.eventStore });
  const activityRows = async () =>
    (
      await db.owner.query<{
        execution_id: string;
        scope: string | null;
        state: ChatActivityState | null;
        erased: boolean;
      }>(
        "SELECT execution_id, scope, state, erased FROM read_model_state WHERE model_id = $1 AND scope IS NOT NULL ORDER BY execution_id",
        [CHAT_ACTIVITY_MODEL],
      )
    ).rows;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    pool = new Pool({ connectionString: db.appUrl });
    keys = new PostgresKeyStore(pool, [{ id: "kek-1", key: createSecretKey(randomBytes(32)) }]);
    durable = createDurableStorage({ loomUrl: db.loomUrl, keys });
    for (const [id, who] of [
      [chatA, "a"],
      [chatB, "b"],
    ] as const) {
      const append = (e: EventEnvelope) => durable.sealed.eventStore.append(e);
      await append(event(id, 0, "EXECUTION_STARTED", { input: {} }));
      await append(record(id, 1, "user", `${who} asked something private`));
      await append(record(id, 2, "reply", `${who} was told something private`));
      await append(event(id, 3, "EXECUTION_COMPLETED", {}));
    }
    for (const id of [ingA, ingB]) {
      const append = (e: EventEnvelope) => durable.sealed.eventStore.append(e);
      await append(event(id, 0, "EXECUTION_STARTED", { input: {} }));
      await append(
        event(id, 1, "STEP_COMPLETED", {
          stepId: "ingest-finalize",
          output: { outcome: "done", note: "private output" },
        }),
      );
    }
    // User A is erased BEFORE any read model has seen the log (a node that was down, or a new model).
    await userShredder({ keys, raw: durable.raw })(A, [chatA, ingA]);
  });

  afterAll(async () => {
    await durable?.storage.eventStore.close?.();
    await durable?.close();
    await pool?.end();
    await db?.drop();
  });

  it("the strict and the tolerant source differ exactly where the log is erased", async () => {
    await expect(durable.sealed.eventStore.read(chatA)).rejects.toBeInstanceOf(
      PayloadShreddedError,
    );
    const tolerant = await fold().read(chatA);
    const choice = (tolerant[1]?.payload as { choice: { text: unknown; role: string } }).choice;
    expect(isShredded(choice.text)).toBe(true);
    expect(choice.role).toBe("user"); // only the sealed path is replaced
    expect((await durable.sealed.eventStore.read(chatB))[1]?.payload).toMatchObject({
      choice: { text: "b asked something private" },
    });
  });

  it("a model behind an erased execution cannot boot through the strict source (E5)", async () => {
    const strict = new ChatActivity({
      writer: writer(),
      source: durable.sealed.eventStore,
      sensitive: sensitive(),
      onError: () => {},
    });
    await expect(strict.boot()).rejects.toBeInstanceOf(PayloadShreddedError);
  });

  it("boots through the tolerant source: the erased execution's row holds no counts, the other user's is intact", async () => {
    const activity = new ChatActivity({
      writer: writer(),
      source: fold(),
      sensitive: sensitive(),
      onError: () => {},
    });
    await activity.boot();
    await activity.close();
    const rows = await activityRows();
    expect(rows.map((r) => r.execution_id).sort()).toEqual([chatA, chatB].sort());
    expect(rows.find((r) => r.execution_id === chatA)).toMatchObject({ scope: A, state: {} });
    expect(rows.find((r) => r.execution_id === chatB)).toMatchObject({
      scope: B,
      state: { n: 2, o: 1 },
    });
  });

  it("a restart is a no-op, and so is a second one", async () => {
    for (let i = 0; i < 2; i++) {
      const activity = new ChatActivity({
        writer: writer(),
        source: fold(),
        sensitive: sensitive(),
        onError: () => {},
      });
      await activity.boot();
      await activity.close();
    }
    const rows = await activityRows();
    expect(rows.map((r) => r.execution_id).sort()).toEqual([chatA, chatB].sort());
    expect(rows.find((r) => r.execution_id === chatA)).toMatchObject({ scope: A, state: {} });
    expect(rows.find((r) => r.execution_id === chatB)).toMatchObject({
      scope: B,
      state: { n: 2, o: 1 },
    });
  });

  it("a version bump re-folds the whole log, erased user included, without throwing", async () => {
    const bumped = projection$<ChatActivityState>({
      id: CHAT_ACTIVITY_MODEL,
      name: "ChatActivity",
      version: "999",
      initialState: INITIAL_ACTIVITY,
      handlers: activityHandlers,
    });
    const service = new ReadModelService(writer(), { sensitive: sensitive(), onError: () => {} });
    const { rebuilt } = await service.registerFolded({
      projection: bumped,
      keyOf: chatKeyOf,
      scopeOf: chatScopeOf,
    });
    expect(rebuilt).toBe(true);
    await service.catchUp([fold()]);
    const rows = await activityRows();
    expect(rows.find((r) => r.execution_id === chatA)?.state).toEqual({});
    expect(rows.find((r) => r.execution_id === chatB)?.state).toMatchObject({ n: 2 });
  });

  it("ingest-status boots through the tolerant source: the erased document's row holds no status, the other user's is intact", async () => {
    const status = new IngestStatus({
      writer: writer(),
      readerFor: () => {
        throw new Error("not used");
      },
      source: fold(),
      sensitive: sensitive(),
      bus: new InMemoryProgressBus(),
      onError: () => {},
    });
    await status.boot();
    const rows = (
      await db.owner.query<{ execution_id: string; scope: string | null; state: unknown }>(
        "SELECT execution_id, scope, state FROM read_model_state WHERE model_id = $1 AND scope IS NOT NULL ORDER BY execution_id",
        [INGEST_STATUS_MODEL],
      )
    ).rows;
    expect(rows.map((r) => r.execution_id).sort()).toEqual([ingA, ingB].sort());
    expect(rows.find((r) => r.execution_id === ingA)).toMatchObject({ scope: A, state: {} });
    expect(rows.find((r) => r.execution_id === ingB)).toMatchObject({
      scope: B,
      state: { status: "ready", step: "finalize", code: null },
    });
  });
});
