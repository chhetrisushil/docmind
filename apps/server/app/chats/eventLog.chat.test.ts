import { inboxStreamId, inboxTopicStreamId } from "@loom/workflow-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoPlaintext, sealedPaths } from "./eventLogProof";
import { chatConversationId } from "./ids";
import { type ChatStack, startChatStack } from "./testStack";
import { C, U } from "./testing";
import { passage } from "./tools/testing";

const CONV = chatConversationId(U, C);
const QUESTION = "What is the Nocturne revenue forecast for next quarter?";
const QUERY = "Nocturne quarterly revenue forecast";
const THINKING = "Weighing which Nocturne memo covers the revenue forecast.";
const ANSWER = "Nocturne expects seventeen thousand dollars of revenue next quarter";
const PASSAGE_TEXT =
  "Nocturne quarterly revenue forecast: seventeen thousand dollars, confidential.";
const TITLE = "Nocturne planning memo (confidential)";
const SECOND = "And what does the Nocturne cost forecast say about hiring?";
const THIRD = "Summarise the Nocturne hiring plan in one sentence please.";
const SECRETS = [
  QUESTION,
  QUERY,
  THINKING,
  ANSWER,
  PASSAGE_TEXT,
  TITLE,
  SECOND,
  THIRD,
  "Checking the figure against the passage.",
];

const PASSAGE = passage({ text: PASSAGE_TEXT, docTitle: TITLE });
let stack: ChatStack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

/** Every raw (sealed) event of the conversation: both generations and both inbox layouts. */
async function rawLog(s: ChatStack) {
  const streams = [
    CONV,
    `${CONV}~1`,
    inboxStreamId(CONV),
    inboxTopicStreamId(CONV, "conversation:turn"),
  ];
  return (await Promise.all(streams.map((id) => s.raw.read(id)))).flat();
}

describe("the raw event log of a full chat holds no content (spec 4.4)", () => {
  it("a question, a tool call over a retrieved passage, thinking, an answer, then two more turns and a rotation", async () => {
    stack = await startChatStack({
      rotateEveryTurns: 2,
      passages: [PASSAGE],
      scripts: [
        {
          steps: [
            { thinking: THINKING },
            { signature: "sig-1" },
            { toolUse: { id: "toolu_1", name: "search_docs", input: { query: QUERY } } },
            { stop: "tool_use" },
          ],
        },
        {
          steps: [
            { thinking: "Checking the figure against the passage." },
            { signature: "sig-2" },
            { text: `${ANSWER} [[${PASSAGE.passageId}]].` },
            { stop: "end_turn" },
          ],
        },
        {
          steps: [
            { text: "Hiring is planned for the second half of the year." },
            { stop: "end_turn" },
          ],
        },
        {
          steps: [{ text: "Hiring starts in the second half of next year." }, { stop: "end_turn" }],
        },
      ],
    });
    const id = await stack.start();
    await stack.send(id, QUESTION);
    expect((await stack.replies(id, 1))[0]).toMatchObject({
      status: "complete",
      text: expect.stringContaining(ANSWER),
    });
    await stack.send(id, SECOND);
    await stack.replies(id, 2);
    await stack.send(id, THIRD);
    await stack.replies(id, 3);

    const raw = await rawLog(stack);
    expect(raw.length).toBeGreaterThan(20);
    // The log was written by the production sealing, and the conversation went through generation 1.
    expect(raw.some((e) => e.executionId === `${CONV}~1`)).toBe(true);
    assertNoPlaintext(raw, SECRETS);
    // And the sealing really happened where the table says (a scan alone passes on an empty log).
    expect([...sealedPaths(raw)].sort()).toEqual(
      expect.arrayContaining([
        "DECISION_RECORDED:choice.text",
        "EXECUTION_STARTED:input.pending",
        "EXECUTION_STARTED:input.turns[].assistant",
        "EXECUTION_STARTED:input.turns[].user",
        "INBOX_MESSAGE:payload",
        "MESSAGE_CONSUMED:payload",
        "STEP_COMPLETED:output.content",
        "STEP_COMPLETED:output.toolCalls[].input",
        "STEP_COMPLETED:output.value",
        "STEP_STARTED:input.messages",
        "STEP_STARTED:input.query",
      ]),
    );
    // The same log, read through the decrypting store, is the conversation.
    const history = await stack.chat.reader.read(CONV, { limit: 50 });
    expect(history.entries.map((e) => e.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(history.entries[0]?.text).toBe(QUESTION);
  });

  it("a refusal's explanation goes to the sealed item store, never to the log", async () => {
    const EXPLANATION = "I cannot help with that request because it is not allowed.";
    stack = await startChatStack({
      scripts: [
        {
          steps: [
            { text: "I can" },
            { stop: "refusal", details: { category: "policy", explanation: EXPLANATION } },
          ],
        },
      ],
    });
    const id = await stack.start();
    await stack.send(id, QUESTION);
    expect((await stack.replies(id, 1))[0]?.status).toBe("complete");
    assertNoPlaintext(await rawLog(stack), [EXPLANATION, QUESTION]);
    expect(stack.items.puts.map((p) => p.item)).toContainEqual({
      kind: "outcome",
      body: { kind: "refusal", details: { category: "policy", explanation: EXPLANATION } },
    });
  });

  it("a failed turn records a fixed reason and leaks nothing", async () => {
    stack = await startChatStack({ scripts: [{ steps: [{ error: "api_error" }] }] });
    const id = await stack.start();
    await stack.send(id, QUESTION);
    expect((await stack.replies(id, 1))[0]).toMatchObject({ status: "failed", text: "" });
    assertNoPlaintext(await rawLog(stack), [QUESTION]);
  });
});
