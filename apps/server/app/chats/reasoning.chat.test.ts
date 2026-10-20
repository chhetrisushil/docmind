import { unwrapTainted } from "@loom/classify";
import { readReasoningBounded } from "@loom/llm";
import { afterEach, describe, expect, it } from "vitest";
import { chatConversationId } from "./ids";
import { type ChatStack, startChatStack } from "./testStack";
import { C, T, U } from "./testing";
import { passage } from "./tools/testing";

const CONV = chatConversationId(U, C);
const QUESTION = "What is the Nocturne revenue forecast for next quarter?";
const FIRST = "Weighing which Nocturne memo covers the revenue forecast.";
const SECOND = "Checking the figure against the passage.";
const SIG1 = "sigA-Zq8Lm2Vx9Rt4Ns6Hd1Wk3Pf7";
const SIG2 = "sigB-Hd1Wk3Pf7Zq8Lm2Vx9Rt4Ns6";
const PASSAGE = passage({
  text: "Nocturne quarterly revenue forecast: seventeen thousand dollars.",
  docTitle: "Memo",
});

let stack: ChatStack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

describe("model reasoning in a chat (ADR 0133 over the real flow)", () => {
  it("streams reasoning on the hub, records it, and reads it back through the decrypting log as the owner", async () => {
    stack = await startChatStack({
      passages: [PASSAGE],
      scripts: [
        {
          steps: [
            { thinking: FIRST },
            { signature: SIG1 },
            {
              toolUse: {
                id: "toolu_1",
                name: "search_docs",
                input: { query: "Nocturne forecast" },
              },
            },
            { stop: "tool_use" },
          ],
        },
        {
          steps: [
            { thinking: SECOND },
            { signature: SIG2 },
            { text: `Seventeen thousand [[${PASSAGE.passageId}]].` },
            { stop: "end_turn" },
          ],
        },
      ],
    });
    const id = await stack.start();
    const live: { turn: number; text: string }[] = [];
    const off = stack.chat.hub.subscribe(id, (ev) => {
      if (ev.type === "reasoning") live.push({ turn: ev.turn, text: ev.text });
    });
    await stack.send(id, QUESTION);
    await stack.replies(id, 1);
    off();

    // live: both model frames' reasoning, in order, under the accepted-turn number of the answer's deltas
    expect(live.map((l) => l.text).join("")).toBe(FIRST + SECOND);
    expect([...new Set(live.map((l) => l.turn))]).toEqual([1]);

    // durable: one captured step per model frame, each the recorded attempt, text read back as the owner
    const read = await readReasoningBounded(
      stack.events,
      stack.reasoning.readerFor({ tenantId: T, userId: U, chatId: C }),
      { executionId: CONV, stepPrefix: "conv#o1#" },
    );
    expect(read.steps.map((s) => s.stepId)).toEqual(["conv#o1#turn:0", "conv#o1#turn:1"]);
    expect(read.steps.map((s) => s.recordedAttempt)).toEqual([1, 1]);
    const parts = read.steps.flatMap((s) => s.attempts.flatMap((a) => a.parts));
    expect(
      parts.map((p) => [
        p.kind,
        p.status,
        p.text === undefined ? undefined : unwrapTainted(p.text),
      ]),
    ).toEqual([
      ["summary", "ok", FIRST],
      ["summary", "ok", SECOND],
    ]);
    expect(read.truncated).toBe(false);

    // continuation: the second request carried the first block back, text and signature, ahead of the tool call
    const assistant = stack.fake.requests[1]?.body.messages.find((m) => m.role === "assistant");
    expect(assistant?.content[0]).toMatchObject({
      type: "thinking",
      thinking: FIRST,
      signature: SIG1,
    });
    expect(assistant?.content.some((b) => b.type === "tool_use")).toBe(true);
  });
});
