import { afterEach, describe, expect, it } from "vitest";
import { opaqueIds } from "../opaqueIds";
import { testOpaqueIds } from "../opaqueIds/testing";
import {
  CHAT_EFFECT_IDS,
  CHAT_TOOL_IDS,
  chatConversationId,
  chatIdOfConversation,
  isChatFlowId,
  isChatTitleExecution,
  isRecoverableChatExecution,
} from "./ids";

const USER = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const CHAT = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";

describe("chatConversationId", () => {
  it("is u_<user>.c-<chat> and is a valid Loom conversation id", () => {
    expect(chatConversationId(USER, CHAT)).toBe(`u_${USER}.c-${CHAT}`);
  });

  it.each([
    ["a non-UUID user", "alice", CHAT],
    ["a non-UUID chat", USER, "chat-1"],
    ["an upper-case user", USER.toUpperCase(), CHAT],
    ["an upper-case chat", USER, CHAT.toUpperCase()],
    ["a separator in the user", `${USER}:x`, CHAT],
    ["a generation suffix in the chat", USER, `${CHAT}~1`],
  ])("refuses %s", (_name, user, chat) => {
    expect(() => chatConversationId(user, chat)).toThrow(RangeError);
  });
});

describe("chatIdOfConversation", () => {
  it("reads the user and the chat back, with or without a generation", () => {
    const id = chatConversationId(USER, CHAT);
    expect(chatIdOfConversation(id)).toEqual({ userId: USER, chatId: CHAT });
    expect(chatIdOfConversation(`${id}~1`)).toEqual({ userId: USER, chatId: CHAT });
    expect(chatIdOfConversation(`${id}~123456789`)).toEqual({ userId: USER, chatId: CHAT });
  });

  it.each([
    ["an ingest execution", `u_${USER}:ingest-${CHAT}`],
    ["a bare user execution", `u_${USER}`],
    ["generation 0 spelled out", `u_${USER}.c-${CHAT}~0`],
    ["a leading-zero generation", `u_${USER}.c-${CHAT}~01`],
    ["a non-numeric generation", `u_${USER}.c-${CHAT}~x`],
    ["trailing text", `u_${USER}.c-${CHAT}.x`],
    ["a child execution", `u_${USER}.c-${CHAT}::child`],
    ["upper case", `U_${USER}.c-${CHAT}`],
    ["a prefixed id", `x${`u_${USER}.c-${CHAT}`}`],
  ])("returns null for %s", (_name, id) => {
    expect(chatIdOfConversation(id)).toBeNull();
  });
});

describe("isChatTitleExecution and isRecoverableChatExecution", () => {
  it("knows a title execution, a conversation and its generations, and nothing else", () => {
    const conv = chatConversationId(USER, CHAT);
    const title = `u_${USER}:chat-title-${CHAT}`;
    expect(isChatTitleExecution(title)).toBe(true);
    expect([conv, `${conv}~2`, title].every(isRecoverableChatExecution)).toBe(true);
    for (const id of [
      `u_${USER}:ingest-${CHAT}`,
      `u_${USER}:chat-title-x`,
      `${title}~1`,
      `x${title}`,
      "conv-1",
    ]) {
      expect(isRecoverableChatExecution(id)).toBe(false);
    }
  });
});

describe("chat ids and grants", () => {
  it("lists the model effect, the summarizer and the five tools", () => {
    expect(CHAT_TOOL_IDS).toEqual([
      "search_docs",
      "related",
      "read_section",
      "get_summary",
      "list_documents",
    ]);
    expect(CHAT_EFFECT_IDS).toEqual(["chat-model", "chat-summarize", ...CHAT_TOOL_IDS]);
  });

  it("knows the two chat flow ids and nothing else", () => {
    expect(["doc-chat", "doc-chat-gk"].every(isChatFlowId)).toBe(true);
    expect(["ingest-document", "chat-title", "doc-chat-x", "conversation"].some(isChatFlowId)).toBe(
      false,
    );
  });
});

describe("the new chat shapes (read now, written by phase 2)", () => {
  const TENANT = "00000000-0000-0000-0000-0000000000aa";
  afterEach(() => opaqueIds.install(undefined));

  async function user() {
    const t = testOpaqueIds();
    t.store.add(USER, TENANT);
    return { ids: t.ids, user: await t.ids.ensureUser({ tenantId: TENANT, userId: USER }) };
  }

  it("reads the user and the chat of an h_ conversation, with or without a generation, once the user is cached", async () => {
    const { ids, user: u } = await user();
    const id = u.conversation(CHAT);
    expect(chatIdOfConversation(id)).toBeNull(); // cold: the tokens cannot be opened
    opaqueIds.install(ids);
    expect(chatIdOfConversation(id)).toEqual({ userId: USER, chatId: CHAT });
    expect(chatIdOfConversation(`${id}~3`)).toEqual({ userId: USER, chatId: CHAT });
    expect(chatIdOfConversation(u.chatTitle(CHAT))).toBeNull(); // a title is not a conversation
  });

  it("classifies a new-format conversation and title from the shape alone, so recovery never misses on a cold cache", async () => {
    const { user: u } = await user();
    expect(opaqueIds.current()).toBeUndefined();
    expect(isChatTitleExecution(u.chatTitle(CHAT))).toBe(true);
    expect(isChatTitleExecution(u.conversation(CHAT))).toBe(false);
    for (const id of [u.chatTitle(CHAT), u.conversation(CHAT), `${u.conversation(CHAT)}~2`])
      expect(isRecoverableChatExecution(id)).toBe(true);
    expect(isRecoverableChatExecution(u.ingest("0f8fad5b-d9cb-469f-a165-70867728950e", 2))).toBe(
      false,
    );
  });
});
