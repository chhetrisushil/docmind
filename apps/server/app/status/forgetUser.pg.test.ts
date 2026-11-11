import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChatActivity } from "../chats/activity";
import { legacyChatConversationId } from "../chats/ids";
import { migrate, setAppRolePassword, setRolePassword } from "../db/migrate";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { InMemoryProgressBus } from "../documents/progress";
import { ALICE, ALICE2, seedUsers } from "../documents/testHarness";
import { loomPoolConfig } from "../storage";
import { IngestStatus } from "./ingestStatus";
import { pgStatusReaderFor, pgStatusWriter, pgUserExecutions } from "./pgStores";
import { MemoryLog, evt, ingestRun } from "./testing";

describe.skipIf(!PG_URL)(
  "forgetUser over Postgres with the Loom role (needs DOCMIND_TEST_PG_URL)",
  () => {
    let db: TestDb;
    let app: Pool;
    let loom: Pool;
    const [A, B] = [ALICE.userId, ALICE2.userId];
    const [doc, chat] = [randomUUID(), randomUUID()];

    beforeAll(async () => {
      db = await createTestDb();
      await migrate(db.owner);
      await setAppRolePassword(db.owner, APP_PASSWORD);
      await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
      await seedUsers(db.owner);
      app = new Pool({ connectionString: db.appUrl });
      loom = new Pool(loomPoolConfig(db.loomUrl));
    });
    afterAll(async () => {
      await loom?.end();
      await app?.end();
      await db?.drop();
    });

    it("leaves no row that is not a tombstone under the user's id prefix, in either model", async () => {
      const log = new MemoryLog();
      const userExecutions = pgUserExecutions(loom);
      const status = new IngestStatus({
        writer: pgStatusWriter(loom),
        readerFor: pgStatusReaderFor(app),
        source: log,
        sensitive: {},
        bus: new InMemoryProgressBus(),
        userExecutions,
        onError: () => {},
      });
      const activity = new ChatActivity({
        writer: pgStatusWriter(loom),
        source: log,
        sensitive: {},
        userExecutions,
        onError: () => {},
      });
      log.append(
        ...ingestRun(`u_${A}:ingest-${doc}`, "ready"),
        ...ingestRun(`u_${A}:chat-title-${chat}`, "started"),
        evt(legacyChatConversationId(A, chat), 0, "EXECUTION_STARTED", { input: {} }),
        ...ingestRun(`u_${B}:ingest-${randomUUID()}`, "ready"), // the other user of the same tenant
      );
      await status.boot();
      await activity.boot();

      await status.forgetUser(A);
      await activity.forgetUser(A);

      const { rows } = await db.owner.query<{
        model_id: string;
        execution_id: string;
        erased: boolean;
        state: unknown;
      }>(
        "SELECT model_id, execution_id, erased, state FROM read_model_state WHERE starts_with(execution_id, $1)",
        [`u_${A}`],
      );
      expect(rows.length).toBeGreaterThanOrEqual(5);
      expect(rows.every((r) => r.erased && r.state === null)).toBe(true);
      const other = await db.owner.query(
        "SELECT 1 FROM read_model_state WHERE starts_with(execution_id, $1) AND NOT erased",
        [`u_${B}`],
      );
      expect(other.rowCount).toBeGreaterThan(0);
      expect(await pgUserExecutions(loom)("ingest-status", A)).toEqual([]);
      expect(await pgUserExecutions(loom)("chat-activity", A)).toEqual([]);
    });

    it("a user who starts a chat and an ingest after boot leaves no live row after the next boot", async () => {
      const [U, doc2, chat2] = [ALICE.userId, randomUUID(), randomUUID()];
      const log = new MemoryLog();
      const userExecutions = pgUserExecutions(loom);
      const make = () => ({
        status: new IngestStatus({
          writer: pgStatusWriter(loom),
          readerFor: pgStatusReaderFor(app),
          source: log,
          sensitive: {},
          bus: new InMemoryProgressBus(),
          userExecutions,
          onError: () => {},
        }),
        activity: new ChatActivity({
          writer: pgStatusWriter(loom),
          source: log,
          sensitive: {},
          userExecutions,
          onError: () => {},
        }),
      });
      const first = make();
      await first.status.boot();
      await first.activity.boot();
      // Started after boot: each model folds only its own executions live.
      const events = [
        ...ingestRun(`u_${U}:ingest-${doc2}`, "ready"),
        evt(legacyChatConversationId(U, chat2), 0, "EXECUTION_STARTED", { input: {} }),
      ];
      log.append(...events);
      for (const e of events) {
        first.status.onEvent(e);
        first.activity.onEvent(e);
      }
      await first.status.drain();
      await first.activity.drain();

      await first.status.forgetUser(U);
      await first.activity.forgetUser(U);

      // The restart: fresh models catch up from the log.
      const second = make();
      await second.status.boot();
      await second.activity.boot();

      const { rows } = await db.owner.query<{ model_id: string; erased: boolean; state: unknown }>(
        "SELECT model_id, erased, state FROM read_model_state WHERE starts_with(execution_id, $1) AND (execution_id LIKE $2 OR execution_id LIKE $3)",
        [`u_${U}`, `%${doc2}`, `%${chat2}`],
      );
      expect(rows.length).toBe(4); // each of the two executions has a row in both models
      expect(rows.every((r) => r.erased && r.state === null)).toBe(true);
    });

    it("the lister takes the prefix literally: neither % nor an underscore acts as a wildcard", async () => {
      const live = `u_${ALICE2.userId}:ingest-${randomUUID()}`;
      const log = new MemoryLog();
      const status = new IngestStatus({
        writer: pgStatusWriter(loom),
        readerFor: pgStatusReaderFor(app),
        source: log,
        sensitive: {},
        bus: new InMemoryProgressBus(),
        onError: () => {},
      });
      log.append(...ingestRun(live, "ready"));
      await status.boot();
      const list = pgUserExecutions(loom);
      expect(await list("ingest-status", "%")).toEqual([]);
      // Under LIKE every "_" would match any one character, so 36 of them would match the live user's rows.
      const lookalike = "_".repeat(ALICE2.userId.length);
      expect(await list("ingest-status", lookalike)).toEqual([]);
      expect(await list("ingest-status", ALICE2.userId)).toContain(live);
    });

    it("tombstones the user's live h_<handle> rows in both models through the pg lister, only with the handle", async () => {
      const H = `${"i".repeat(25)}e`;
      const H2 = `${"m".repeat(25)}e`;
      const t52 = "q".repeat(52);
      const mineIngest = `h_${H}:ingest-${t52}.2`;
      const mineChat = `h_${H}.c-${t52}`;
      const theirs = `h_${H2}:ingest-${t52}.2`;
      for (const [model, id] of [
        ["ingest-status", mineIngest],
        ["chat-activity", mineChat],
        ["ingest-status", theirs],
      ] as const)
        await db.owner.query(
          "INSERT INTO read_model_state (model_id, execution_id, app_key, scope, sequence, state, erased) VALUES ($1, $2, NULL, NULL, 0, '{}', false)",
          [model, id],
        );
      const list = pgUserExecutions(loom);
      expect(await list("ingest-status", A)).not.toContain(mineIngest); // no handle: not looked for
      expect(await list("ingest-status", A, H)).toEqual([mineIngest]);
      expect(await list("chat-activity", A, H)).toEqual([mineChat]);
      const log = new MemoryLog();
      const make = () => ({
        status: new IngestStatus({
          writer: pgStatusWriter(loom),
          readerFor: pgStatusReaderFor(app),
          source: log,
          sensitive: {},
          bus: new InMemoryProgressBus(),
          userExecutions: list,
          onError: () => {},
        }),
        activity: new ChatActivity({
          writer: pgStatusWriter(loom),
          source: log,
          sensitive: {},
          userExecutions: list,
          onError: () => {},
        }),
      });
      const m = make();
      await m.status.boot();
      await m.activity.boot();
      await m.status.forgetUser(A);
      await m.activity.forgetUser(A);
      const live = async (id: string) =>
        (await db.owner.query("SELECT erased FROM read_model_state WHERE execution_id = $1", [id]))
          .rows[0]?.erased;
      expect(await live(mineIngest)).toBe(false); // without the handle the rows stay
      await m.status.forgetUser(A, H);
      await m.activity.forgetUser(A, H);
      expect(await live(mineIngest)).toBe(true);
      expect(await live(mineChat)).toBe(true);
      expect(await live(theirs)).toBe(false);
    });
    it("a rebuild after erasure leaves no scope or app_key on a row under the erased handle (the fold of an unknown h_ execution is neutral)", async () => {
      const { opaqueIds } = await import("../opaqueIds");
      const { testOpaqueIds } = await import("../opaqueIds/testing");
      const { handleListerPrefixes } = await import("../opaqueIds");
      const [who, docId, chatId] = [ALICE.userId, randomUUID(), randomUUID()];
      const t = testOpaqueIds();
      t.store.add(who, ALICE.tenantId);
      const user = await t.ids.ensureUser({ tenantId: ALICE.tenantId, userId: who });
      opaqueIds.install(t.ids);
      try {
        const ingestId = user.ingest(docId, 2);
        const conv = user.conversation(chatId);
        const log = new MemoryLog();
        log.append(
          ...ingestRun(ingestId, "ready"),
          evt(conv, 0, "EXECUTION_STARTED", { input: {} }),
        );
        const userExecutions = pgUserExecutions(loom);
        const make = () => ({
          status: new IngestStatus({
            writer: pgStatusWriter(loom),
            readerFor: pgStatusReaderFor(app),
            source: log,
            sensitive: {},
            bus: new InMemoryProgressBus(),
            userExecutions,
            onError: () => {},
          }),
          activity: new ChatActivity({
            writer: pgStatusWriter(loom),
            source: log,
            sensitive: {},
            userExecutions,
            onError: () => {},
          }),
        });
        const linked = (h: string) => {
          const p = handleListerPrefixes(h);
          return db.owner.query<{ model_id: string; scope: string | null; app_key: string | null }>(
            `SELECT model_id, scope, app_key FROM read_model_state
              WHERE execution_id = $1 OR starts_with(execution_id, $2) OR starts_with(execution_id, $3)`,
            [p.exact, ...p.starts],
          );
        };
        const first = make();
        await first.status.boot();
        await first.activity.boot();
        const before = await linked(user.handle);
        expect(before.rows.map((r) => [r.scope, r.app_key])).toEqual(
          expect.arrayContaining([[who, docId]]),
        ); // the precondition: a live user's rows do link
        expect(before.rows.length).toBe(4); // each of the two executions has a row in both models

        // Erasure: the models forget, the handle row and the key go, the cache drops the user.
        await first.status.forgetUser(who, user.handle);
        await first.activity.forgetUser(who, user.handle);
        await t.keys.destroy(who);
        t.store.rows.delete(who);
        t.ids.forgetSubject(who);
        // A rebuild (a changed projection version, or a restored database) re-folds the log from nothing.
        await db.owner.query(
          "DELETE FROM read_model_state WHERE execution_id = $1 OR starts_with(execution_id, $2) OR starts_with(execution_id, $3)",
          [`h_${user.handle}`, `h_${user.handle}:`, `h_${user.handle}.c-`],
        );
        const second = make();
        await second.status.boot();
        await second.activity.boot();
        const after = await linked(user.handle);
        expect(after.rows.length).toBe(4); // the rows exist again (neutral), under the handle only
        expect(after.rows.every((r) => r.scope === null && r.app_key === null)).toBe(true);
      } finally {
        opaqueIds.install(undefined);
      }
    });
  },
);
