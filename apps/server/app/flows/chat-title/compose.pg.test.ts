import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import type { LlmProvider } from "@loom/llm";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { InMemoryReadModelStore } from "@loom/plugin-read-model";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadChatSettings } from "../../chats/settings";
import { buildServer } from "../../compose";
import { migrate, setAppRolePassword } from "../../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../../db/testSupport";
import { loadBlobRoot, loadLimits } from "../../documents/limits";
import { SENSITIVE_EVENT_PATHS } from "../../sensitive";
import { subjectOfExecution } from "../../subject";
import { createIngestWiring } from "../ingest-document/limits";

describe.skipIf(!PG_URL)(
  "compose wires the real title starter into the send route (needs DOCMIND_TEST_PG_URL)",
  () => {
    let db: TestDb;
    let pool: Pool;
    const root = mkdtempSync(join(tmpdir(), "dm-compose-title-"));
    beforeAll(async () => {
      db = await createTestDb();
      await migrate(db.owner);
      await setAppRolePassword(db.owner, APP_PASSWORD);
      pool = new Pool({ connectionString: db.appUrl });
    });
    afterAll(async () => {
      await pool.end();
      await db.drop();
      rmSync(root, { recursive: true, force: true });
    });

    const stub = {
      complete: async () => ({ content: "x", stopReason: "end_turn" }),
    } as unknown as LlmProvider;

    function compose(titleLlm: boolean) {
      const events = new EncryptingEventStore(
        new InMemoryAsyncEventStore(),
        new InMemoryKeyStore(),
        {
          sensitive: { ...SENSITIVE_EVENT_PATHS },
          subjectOf: subjectOfExecution,
        },
      );
      const store = new InMemoryReadModelStore();
      return buildServer({
        pool,
        keys: new InMemoryKeyStore(),
        storage: { kind: "custom", eventStore: events },
        crypto: { events },
        limits: loadLimits({}),
        blobRoot: loadBlobRoot({ DOCMIND_BLOB_DIR: root }),
        secureCookies: false,
        trustProxy: false,
        ingest: { ...createIngestWiring({ DOCMIND_LLM_PROVIDER: "off" }), sleep: async () => {} },
        status: { writer: store, readerFor: () => store, source: events },
        chat: {
          settings: loadChatSettings({ DOCMIND_LLM_PROVIDER: "off" }),
          llm: { provider: stub, observer: {} },
          ...(titleLlm && { titleLlm: stub }),
          timers: new InMemoryTimerStore(),
        },
      });
    }

    async function sendOnce(composed: ReturnType<typeof compose>, email: string) {
      await new Promise<void>((resolve) => composed.server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(composed.server.address() as AddressInfo).port}`;
      const json = (path: string, body: unknown, cookie = "") =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify(body),
        });
      const creds = { email, password: "correct horse battery" };
      expect((await json("/api/auth/sign-up", creds)).status).toBe(202);
      const login = await json("/api/auth/login", creds);
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
      const created = await json("/api/chats", { scope: "all" }, cookie);
      expect(created.status).toBe(201);
      const chat = (await created.json()) as { id: string };
      const sent = await json(
        `/api/chats/${chat.id}/messages`,
        { text: "When is payment due?" },
        cookie,
      );
      expect(sent.status).toBe(202);
      const user = (
        await db.owner.query("SELECT id, tenant_id FROM users WHERE email = $1", [email])
      ).rows[0];
      return { chatId: chat.id, userId: user.id as string, tenantId: user.tenant_id as string };
    }

    async function close(composed: ReturnType<typeof compose>) {
      await new Promise<void>((resolve) => {
        composed.server.close(() => resolve());
        composed.server.closeAllConnections();
      });
      await composed.chat?.close();
      await composed.status.close();
      await composed.app.close();
    }

    it("with a title model: the routes hold the real starter and a send to an untitled chat fires it with ids only", async () => {
      const composed = compose(true);
      expect(composed.titles).toBeDefined();
      expect(typeof composed.titles?.start).toBe("function");
      expect(typeof composed.titles?.idle).toBe("function");
      const fire = vi
        .spyOn(composed.titles as NonNullable<typeof composed.titles>, "fire")
        .mockImplementation(() => {});
      try {
        const ids = await sendOnce(composed, "title-on@example.test");
        expect(fire.mock.calls).toEqual([[ids]]);
      } finally {
        await close(composed);
      }
    });

    it("without a title model: a send fires nothing", async () => {
      const composed = compose(false);
      const fire = vi
        .spyOn(composed.titles as NonNullable<typeof composed.titles>, "fire")
        .mockImplementation(() => {});
      try {
        await sendOnce(composed, "title-off@example.test");
        expect(fire).not.toHaveBeenCalled();
      } finally {
        await close(composed);
      }
    });
  },
);
