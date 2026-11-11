import { rmSync } from "node:fs";
import { ChatSessionDto } from "@docmind/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import { collectUntil, isReply, scriptChat } from "./e2eSupport";

const isEnvelope = (v: unknown) =>
  (v as { __loomEnc?: unknown } | null)?.__loomEnc === "loom/aes-256-gcm";

describe.skipIf(!PG_URL)(
  "a conversation's log holds no plain owner or sender (needs DOCMIND_TEST_PG_URL)",
  () => {
    let st: IngestStack | undefined;
    afterAll(async () => {
      await st?.close({ keepDb: true });
      await st?.db.drop();
      if (st) rmSync(st.root, { recursive: true, force: true });
    });

    it("seals input.owner and sender, and the decrypting store still reads them", async () => {
      st = await startIngestStack({ chat: true });
      const claude = st.claude;
      if (!claude) throw new Error("no fake Claude");
      const who = await st.signUpAndLogIn("sealed@example.com");
      scriptChat(claude, () => ({ stream: { steps: [{ text: "Hello." }, { stop: "end_turn" }] } }));
      const chat = ChatSessionDto.parse(
        await (await st.chatReq(who.cookie, "POST", "/api/chats", {})).json(),
      );
      const stream = await st.openChat(who.cookie, chat.id);
      try {
        const sent = await st.chatReq(who.cookie, "POST", `/api/chats/${chat.id}/messages`, {
          text: "Hi",
        });
        expect(sent.status).toBe(202);
        await collectUntil(stream, isReply);
      } finally {
        stream.close();
      }
      const all = (await st.durable.raw.eventStore.listExecutions?.()) ?? [];
      const conversation = all.find(
        (id) => id.includes(".c-") && !id.includes("::") && !id.startsWith("__loom"),
      );
      expect(conversation).toBeDefined();
      const raw = await st.durable.raw.eventStore.read(conversation as string);
      const started = raw.find((e) => e.eventType === "EXECUTION_STARTED");
      const consumed = raw.filter((e) => e.eventType === "MESSAGE_CONSUMED");
      expect(consumed.length).toBeGreaterThan(0); // the control: the events the claim is about exist
      expect(isEnvelope((started?.payload as { input?: { owner?: unknown } }).input?.owner)).toBe(
        true,
      );
      for (const e of consumed)
        expect(isEnvelope((e.payload as { sender?: unknown }).sender)).toBe(true);
      // The payloads hold neither the user's nor the tenant's id outside a sealed envelope. Only the payloads are judged: the envelope's
      // `executionId` is `u_<user>.c-<chat>` until Task 4 flips the chat builders, and is judged by the Task 4 and 5 tests.
      const plain = JSON.stringify(
        [started?.payload, ...consumed.map((e) => e.payload)],
        (_k, v) => (isEnvelope(v) ? "sealed" : v),
      );
      expect(plain).not.toContain(who.userId);
      expect(plain).not.toContain(who.tenantId);
      // the owner's own key still opens them, as Loom needs
      const opened = await st.durable.sealed.eventStore.read(conversation as string);
      const openedStart = opened.find((e) => e.eventType === "EXECUTION_STARTED");
      const owner = (
        openedStart?.payload as { input: { owner: { actor: string; tenant: string } } }
      ).input.owner;
      expect(owner).toMatchObject({ actor: who.userId, tenant: who.tenantId });
      const openedConsumed = opened.filter((e) => e.eventType === "MESSAGE_CONSUMED");
      expect(openedConsumed.length).toBe(consumed.length);
      for (const e of openedConsumed)
        expect((e.payload as { sender: unknown }).sender).toMatchObject({
          actor: who.userId,
          tenant: who.tenantId,
        });
    }, 120_000);
  },
);
