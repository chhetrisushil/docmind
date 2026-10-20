import type { StreamScript } from "@docmind/llm-anthropic/testing";
import { afterEach, describe, expect, it } from "vitest";
import { assertNoPlaintext, sealedPaths } from "./eventLogProof";
import { chatConversationId } from "./ids";
import { type ChatStack, startChatStack } from "./testStack";
import { C, T, U } from "./testing";
import { passage } from "./tools/testing";

const CONV = chatConversationId(U, C);
const QUESTION = "What is the Nocturne revenue forecast for next quarter?";
const QUERY = "Nocturne quarterly revenue forecast";
const THINKING = "Weighing which Nocturne memo covers the revenue forecast.";
const ANSWER = "Nocturne expects seventeen thousand dollars of revenue next quarter";
const PASSAGE_TEXT =
  "Nocturne quarterly revenue forecast: seventeen thousand dollars, confidential.";
const TITLE = "Nocturne planning memo (confidential)";
const SIG1 = "sigA-Zq8Lm2Vx9Rt4Ns6Hd1Wk3Pf7";
const SIG2 = "sigB-Hd1Wk3Pf7Zq8Lm2Vx9Rt4Ns6";
const THINK2 = "Checking the figure against the passage.";
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
  THINK2,
  SIG1,
  SIG2,
];

const PASSAGE = passage({ text: PASSAGE_TEXT, docTitle: TITLE });
let stack: ChatStack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

/** Every raw (sealed) event in the store: every execution, generation and inbox stream, not a listed set. */
async function rawLog(s: ChatStack) {
  const ids = await s.raw.listExecutions();
  return (await Promise.all(ids.map((id) => s.raw.read(id)))).flat();
}

describe("the raw event log of a full chat holds no content (spec 4.4)", () => {
  it("a question, a tool call over a retrieved passage, thinking, an answer, then two more turns and a rotation", async () => {
    const scripts: StreamScript[] = [
      {
        steps: [
          { thinking: THINKING },
          { signature: SIG1 },
          { toolUse: { id: "toolu_1", name: "search_docs", input: { query: QUERY } } },
          { stop: "tool_use" },
        ],
      },
      {
        steps: [
          { thinking: THINK2 },
          { signature: SIG2 },
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
    ];
    stack = await startChatStack({ rotateEveryTurns: 2, passages: [PASSAGE], scripts });
    // Serve the same scripts through a recording reply: the provider turns the first one's thinking into
    // reasoning (provider tests), so THINKING really reached it and the scan below is not vacuous for it.
    const served: StreamScript[] = [];
    const queue = [...scripts];
    stack.fake.reply(() => {
      const next = queue.shift() as StreamScript;
      served.push(next);
      return { stream: next };
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
        "LLM_REASONING_CAPTURED:parts",
        "STEP_COMPLETED:output.content",
        "STEP_COMPLETED:output.reasoning",
        "STEP_COMPLETED:output.toolCalls[].input",
        "STEP_COMPLETED:output.value",
        "STEP_STARTED:input.messages",
        "STEP_STARTED:input.query",
      ]),
    );
    expect(JSON.stringify(served)).toContain(THINKING);
    // The reasoning really reached the store, sealed under the owner's key (so the scan above is not vacuous for it).
    const sealedRows = [...stack.reasoningRows.rows.values()];
    expect(sealedRows).toHaveLength(2); // one summary per model frame of the first turn
    for (const r of sealedRows)
      expect((r.sealed as { __loomEnc?: string }).__loomEnc).toBe("loom/aes-256-gcm");
    expect(JSON.stringify(sealedRows)).not.toContain("Nocturne");
    const reader = stack.reasoning.readerFor({ tenantId: T, userId: U, chatId: C });
    const texts = await Promise.all(
      sealedRows.map(async (r) =>
        new TextDecoder().decode(
          (await reader.get({ __loomContent: r.address })) ?? new Uint8Array(),
        ),
      ),
    );
    expect(texts.some((t) => t.includes(THINKING))).toBe(true);
    // Only the owner's key was used.
    expect([...stack.subjects]).toEqual([U]);
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

  it("a stopped turn seals its partial text and keeps it out of the log", async () => {
    const PARTIAL = "The Nocturne forecast is partial text that was cut off";
    stack = await startChatStack({
      scripts: [
        { steps: [{ text: PARTIAL }, { hold: true }, { text: " and more" }, { stop: "end_turn" }] },
      ],
    });
    const id = await stack.start();
    await stack.send(id, QUESTION);
    const gate = await stack.fake.streamHold();
    expect(stack.chat.stops.stop(CONV)).toBe(true);
    gate.release();
    expect((await stack.replies(id, 1))[0]).toMatchObject({ status: "interrupted" });
    const raw = await rawLog(stack);
    assertNoPlaintext(raw, [PARTIAL, QUESTION]);
    expect([...sealedPaths(raw)]).toContain("DECISION_RECORDED:choice.partial");
  });

  it("a failing tool's collaborator message never reaches the log", async () => {
    const LEAK = "connection refused for Nocturne quarterly revenue forecast";
    stack = await startChatStack({
      searchError: new Error(LEAK),
      scripts: [
        {
          steps: [
            { toolUse: { id: "toolu_1", name: "search_docs", input: { query: QUERY } } },
            { stop: "tool_use" },
          ],
        },
        { steps: [{ text: "I could not search just now." }, { stop: "end_turn" }] },
      ],
    });
    const id = await stack.start();
    await stack.send(id, QUESTION);
    await stack.replies(id, 1);
    const raw = await rawLog(stack);
    assertNoPlaintext(raw, [LEAK, QUERY]);
    expect(raw.some((e) => e.eventType === "STEP_FAILED")).toBe(true);
    expect([...sealedPaths(raw)]).toContain("STEP_FAILED:error");
  });

  it("an interleaved thinking, tool call, thinking, tool call turn seals its layout, and the model gets the blocks back in that order", async () => {
    const FIRST = "First, which memo covers the Nocturne cost forecast?";
    const SECOND_THOUGHT = "Second, is the hiring figure in the same Nocturne memo?";
    stack = await startChatStack({
      passages: [PASSAGE],
      scripts: [
        {
          steps: [
            { thinking: FIRST },
            { signature: SIG1 },
            { toolUse: { id: "toolu_1", name: "search_docs", input: { query: QUERY } } },
            { thinking: SECOND_THOUGHT },
            { signature: SIG2 },
            {
              toolUse: { id: "toolu_2", name: "search_docs", input: { query: `${QUERY} hiring` } },
            },
            { stop: "tool_use" },
          ],
        },
        { steps: [{ text: `${ANSWER} [[${PASSAGE.passageId}]].` }, { stop: "end_turn" }] },
      ],
    });
    const id = await stack.start();
    await stack.send(id, QUESTION);
    await stack.replies(id, 1);
    const raw = await rawLog(stack);
    assertNoPlaintext(raw, [FIRST, SECOND_THOUGHT, SIG1, SIG2, QUESTION]);
    expect([...sealedPaths(raw)]).toEqual(
      expect.arrayContaining([
        "STEP_COMPLETED:output.layout",
        "STEP_COMPLETED:output.reasoning",
        "LLM_REASONING_CAPTURED:parts",
      ]),
    );
    // the second request carried the blocks back in the order they were made, with text and signature
    const assistant = stack.fake.requests[1]?.body.messages.find((m) => m.role === "assistant");
    expect(assistant?.content.map((b) => b.type)).toEqual([
      "thinking",
      "tool_use",
      "thinking",
      "tool_use",
    ]);
    expect(assistant?.content[0]).toMatchObject({
      type: "thinking",
      thinking: FIRST,
      signature: SIG1,
    });
    expect(assistant?.content[2]).toMatchObject({
      type: "thinking",
      thinking: SECOND_THOUGHT,
      signature: SIG2,
    });
  });

  it("a refused response keeps no reasoning: nothing is stored and no capture event is written", async () => {
    stack = await startChatStack({
      scripts: [
        {
          steps: [
            { thinking: THINKING },
            { signature: SIG1 },
            { text: "I can" },
            { stop: "refusal", details: { category: "policy" } },
          ],
        },
      ],
    });
    const id = await stack.start();
    await stack.send(id, QUESTION);
    await stack.replies(id, 1);
    expect(stack.reasoningRows.rows.size).toBe(0);
    const raw = await rawLog(stack);
    expect(raw.some((e) => e.eventType === "LLM_REASONING_CAPTURED")).toBe(false);
    assertNoPlaintext(raw, [THINKING, SIG1]);
  });
});
