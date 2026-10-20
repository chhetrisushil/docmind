import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@loom/core";
import { InMemoryReadModelStore, foldedStates } from "@loom/plugin-read-model";
import { describe, expect, it } from "vitest";
import { InMemoryProgressBus } from "../documents/progress";
import { SENSITIVE_EVENT_PATHS } from "../sensitive";
import { IngestStatus } from "../status/ingestStatus";
import { INGEST_STATUS_MODEL } from "../status/model";
import { MemoryLog, evt, ingestRun } from "../status/testing";
import { flowSteps, statusSensitive } from "../status/wire";
import { CHAT_ACTIVITY_MODEL, ChatActivity } from "./activity";
import { chatConversationId } from "./ids";

const U = randomUUID();
const C = randomUUID();
const D = randomUUID();
const CONV = chatConversationId(U, C);
const TITLE = `u_${U}:chat-title-${C}`;
const INGEST = `u_${U}:ingest-${D}`;

/** Every word that is a key of a folded state (or a value of the ingest enum) a user could type as a message. */
const WORDS = ["status", "uploaded", "messages", "lastOrd", "lastAt"];

/** The real production sensitive map: the registered sealed paths, through the same helper the server uses. */
const sensitive = () =>
  statusSensitive(flowSteps(), {
    sealingCapability: () =>
      ({
        covers: Object.entries(SENSITIVE_EVENT_PATHS).flatMap(([type, paths]) =>
          paths.map((p) => `${type}.${p}`),
        ),
      }) as never,
  });

/** A chat whose model listed the user's documents (objects with a `status` key under a sealed path) after user messages equal to every state word. */
function chatLog(): EventEnvelope[] {
  const out: EventEnvelope[] = [
    evt(CONV, 0, "EXECUTION_STARTED", {
      input: { turns: WORDS.map((w) => ({ user: w, assistant: w })), summary: "uploaded" },
    }),
  ];
  WORDS.forEach((word, i) => {
    const ord = i + 1;
    const base = out.length;
    out.push(
      evt(CONV, base + 0, "DECISION_RECORDED", {
        decisionId: `conv#o${ord}:user`,
        source: "conversation-record",
        choice: { turn: ord, role: "user", status: "complete", ord, text: word },
      }),
      evt(CONV, base + 1, "STEP_STARTED", {
        stepId: `conv#o${ord}#turn:0`,
        input: { messages: [{ role: "user", content: [{ type: "text", text: word }] }] },
      }),
      evt(CONV, base + 2, "STEP_COMPLETED", {
        stepId: `conv#o${ord}#turn:0:tool:0`,
        output: {
          value: {
            documents: [
              { documentId: D, title: word, mime: "text/plain", status: "ready", createdAt: word },
            ],
          },
        },
      }),
      evt(CONV, base + 3, "STEP_COMPLETED", {
        stepId: `conv#o${ord}#turn:0`,
        output: { content: word, stopReason: "end_turn" },
      }),
      evt(CONV, base + 4, "DECISION_RECORDED", {
        decisionId: `conv#o${ord}:reply`,
        source: "conversation-record",
        choice: { turn: ord, role: "assistant", status: "complete", ord, text: word },
      }),
    );
  });
  return out;
}

const titleLog = (): EventEnvelope[] => [
  evt(TITLE, 0, "EXECUTION_STARTED", { input: {} }),
  evt(TITLE, 1, "STEP_COMPLETED", { stepId: "chat-title-name", output: { content: "uploaded" } }),
];

describe("a chat's events never poison a folded model (the sensitive guard cannot refuse them)", () => {
  it("folds the real ingest status and chat activity over a chat log of state words, twice, and keeps both models right", async () => {
    const log = new MemoryLog();
    log.append(...ingestRun(INGEST, "ready"), ...chatLog(), ...titleLog());
    const writer = new InMemoryReadModelStore();
    const errors: unknown[] = [];
    const make = () => ({
      status: new IngestStatus({
        writer,
        readerFor: () => writer,
        source: log,
        sensitive: sensitive(),
        bus: new InMemoryProgressBus(),
        onError: (e) => errors.push(e),
      }),
      activity: new ChatActivity({
        writer,
        source: log,
        sensitive: sensitive(),
        onError: (e) => errors.push(e),
      }),
    });
    for (let boot = 0; boot < 2; boot++) {
      const { status, activity } = make();
      await status.boot(); // a poison event makes boot throw: the server would not start
      await activity.boot();
      // and live: the same events again are folded or skipped, never refused
      for (const e of chatLog()) {
        status.onEvent(e);
        activity.onEvent(e);
      }
      await status.drain();
      await activity.drain();
      expect(errors).toEqual([]);
    }
    const ingestRows = foldedStates(
      (await writer.getFoldedByKey?.(INGEST_STATUS_MODEL, [D])) ?? [],
    );
    expect(ingestRows.map((r) => r.state)).toEqual([
      { status: "ready", step: "finalize", code: null },
    ]);
    const activityRows = foldedStates(
      (await writer.getFoldedByKey?.(CHAT_ACTIVITY_MODEL, [C])) ?? [],
    );
    expect(activityRows.map((r) => r.state)).toMatchObject([
      { n: WORDS.length * 2, o: WORDS.length },
    ]);
  });
});
