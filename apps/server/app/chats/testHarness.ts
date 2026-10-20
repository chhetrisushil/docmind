import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Identity } from "@docmind/auth";
import { ConversationHub } from "@loom/conversation";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { InMemoryReadModelStore } from "@loom/plugin-read-model";
import { Pool } from "pg";
import { FieldCrypto } from "../crypto/fields";
import { migrate, setAppRolePassword } from "../db/migrate";
import { withTenant } from "../db/tenant";
import { APP_PASSWORD, createTestDb } from "../db/testSupport";
import { seedUsers, testAuthenticator } from "../documents/testHarness";
import { createHttpServer } from "../server";
import { MemoryLog } from "../status/testing";
import { ChatActivity } from "./activity";
import { ChatBus } from "./bus";
import { type FakeConversations, fakeConversations } from "./fakeConversations";
import { chatConversationId } from "./ids";
import { PgReasoningRows } from "./pgReasoningRows";
import { ChatReasoningStore } from "./reasoningStore";
import { type ChatRouteDeps, type ChatTitleTrigger, chatRoutes } from "./routes";
import { chatTitleBind, insertChat, setTitle } from "./sessions";
import type { ChatSettings } from "./settings";
import { StopRegistry } from "./stop";
import { FakeReplyReasoning } from "./testing";
import { PgTurnItems } from "./turnItems";
import type { ChatWiring } from "./wiring";

export interface ChatHarness {
  base: string;
  owner: Pool;
  app: Pool;
  keys: InMemoryKeyStore;
  fields: FieldCrypto;
  fake: FakeConversations;
  wiring: ChatWiring;
  activity: ChatActivity;
  reasoning: FakeReplyReasoning;
  deps: ChatRouteDeps;
  /** A request as one of the harness users (alice, alice2, bob). */
  req(user: string, method: string, path: string, body?: unknown): Promise<Response>;
  close(): Promise<void>;
}

/** A migrated database, two tenants, the chat routes over the fake conversations, on 127.0.0.1. */
export async function startChatServer(
  o: { available?: boolean; pageCap?: number; titles?: ChatTitleTrigger } = {},
): Promise<ChatHarness> {
  const db = await createTestDb();
  await migrate(db.owner);
  await setAppRolePassword(db.owner, APP_PASSWORD);
  await seedUsers(db.owner);
  const app = new Pool({ connectionString: db.appUrl });
  const keys = new InMemoryKeyStore();
  const fields = new FieldCrypto(keys);
  const fake = fakeConversations(o.pageCap === undefined ? {} : { pageCap: o.pageCap });
  const activity = new ChatActivity({
    writer: new InMemoryReadModelStore(),
    source: new MemoryLog(),
    sensitive: {},
    onError: () => {},
  });
  const wiring: ChatWiring = {
    conversations: fake.api,
    hub: new ConversationHub(),
    bus: new ChatBus(),
    stops: new StopRegistry(),
    items: new PgTurnItems(app, fields),
    reasoning: new ChatReasoningStore(new PgReasoningRows(app), fields),
    reader: fake.api.reader,
    available: o.available ?? true,
    settings: {} as ChatSettings, // the routes never read it
    close: async () => {},
  };
  const reasoning = new FakeReplyReasoning();
  const deps: ChatRouteDeps = {
    pool: app,
    authenticator: testAuthenticator,
    fields,
    chat: wiring,
    eventStore: fake.eventStore,
    reasoning,
    ...(o.titles && { titles: o.titles }),
  };
  const server = createHttpServer({ ...chatRoutes(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    owner: db.owner,
    app,
    keys,
    fields,
    fake,
    wiring,
    activity,
    reasoning,
    deps,
    req(user, method, path, body) {
      return fetch(`${base}${path}`, {
        method,
        headers: {
          "x-test-user": user,
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await activity.close();
      await app.end();
      await db.drop();
    },
  };
}

/** A chat of `who`, started in the fake, optionally titled, aged and with folded activity. Returns its id. */
export async function seedChat(
  h: Pick<ChatHarness, "owner" | "app" | "fields" | "fake">,
  who: Identity,
  o: { title?: string; ageSeconds?: number; messages?: number; lastAt?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await withTenant(h.app, who.tenantId, (tx) =>
    insertChat(tx, who.tenantId, who.userId, id, "all"),
  );
  await h.fake.api.start({
    conversationId: chatConversationId(who.userId, id),
    principal: { tenant: who.tenantId, actor: who.userId },
  });
  if (o.ageSeconds !== undefined)
    await h.owner.query(
      "UPDATE chat_sessions SET created_at = now() - make_interval(secs => $2::float8) WHERE id = $1",
      [id, o.ageSeconds],
    );
  if (o.title !== undefined) {
    const enc = await h.fields.forUser(who.userId).seal(chatTitleBind(id), o.title);
    await withTenant(h.app, who.tenantId, (tx) => setTitle(tx, who.userId, id, enc, "user"));
  }
  if (o.messages !== undefined)
    await h.owner.query(
      `INSERT INTO read_model_state (model_id, execution_id, app_key, scope, sequence, state)
       VALUES ('chat-activity', $1, $2, $3, 0, $4::jsonb)`,
      [
        chatConversationId(who.userId, id),
        id,
        who.userId,
        JSON.stringify({
          messages: o.messages,
          lastOrd: o.messages,
          lastAt: o.lastAt === undefined ? null : Date.parse(o.lastAt) + 0.5,
        }),
      ],
    );
  return id;
}

/** `n` untitled chats of `who`, one second apart, the newest first in the list; the owner role, one statement. */
export async function seedManyChats(owner: Pool, who: Identity, n: number): Promise<void> {
  await owner.query(
    `INSERT INTO chat_sessions (id, tenant_id, user_id, scope, created_at)
     SELECT gen_random_uuid(), $1, $2, '"all"'::jsonb, now() - make_interval(secs => g)
       FROM generate_series(1, $3::int) g`,
    [who.tenantId, who.userId, n],
  );
}
