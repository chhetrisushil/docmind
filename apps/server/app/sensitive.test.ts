import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { chatConversationId } from "./chats/ids";
import { SENSITIVE_EVENT_PATHS } from "./sensitive";
import { subjectOfExecution } from "./subject";

const U = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const C = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const EXEC = chatConversationId(U, C);
const isSealed = (v: unknown) =>
  (v as { __loomEnc?: string } | undefined)?.__loomEnc === "loom/aes-256-gcm";

async function roundTrip(
  executionId: string,
  events: Omit<EventEnvelope, "id" | "executionId" | "workflowId" | "timestamp" | "sequence">[],
) {
  const inner = new InMemoryAsyncEventStore();
  const store = new EncryptingEventStore(inner, new InMemoryKeyStore(), {
    sensitive: { ...SENSITIVE_EVENT_PATHS },
    subjectOf: subjectOfExecution,
  });
  for (const [i, e] of events.entries()) {
    await store.append({
      id: `${executionId}-${i}`,
      executionId,
      workflowId: "doc-chat",
      timestamp: i,
      sequence: i,
      ...e,
    } as EventEnvelope);
  }
  return { raw: await inner.read(executionId), plain: await store.read(executionId) };
}

describe("SENSITIVE_EVENT_PATHS for conversations", () => {
  it("seals the reasoning parts and layout of a model frame and the references of the capture event, and the store opens them again", async () => {
    const reasoning = [
      {
        type: "reasoning",
        kind: "summary",
        provider: "anthropic",
        signature: "SIG-secret-bytes-0123456789",
        textRef: { address: "0123456789abcdef0123456789abcdef", size: 41 },
        digest: "d".repeat(64),
      },
    ];
    const layout = ["reasoning", { call: "toolu_1" }, "reasoning", { call: "toolu_2" }];
    const captured = {
      stepId: "conv#o1#turn:0",
      attempt: 1,
      provider: "anthropic",
      model: "claude-opus-5-5",
      parts: [
        {
          kind: "summary",
          ref: "0123456789abcdef0123456789abcdef",
          digest: "d".repeat(64),
          size: 41,
        },
      ],
    };
    const { raw, plain } = await roundTrip(EXEC, [
      {
        eventType: "STEP_COMPLETED",
        payload: {
          stepId: "conv#o1#turn:0",
          output: {
            content: "a",
            toolCalls: [{ id: "toolu_1", name: "search_docs", input: { query: "q" } }],
            stopReason: "tool_use",
            reasoning,
            layout,
          },
        },
      },
      { eventType: "LLM_REASONING_CAPTURED", payload: captured },
    ]);
    const out = (raw[0]?.payload as { output: Record<string, unknown> }).output;
    expect([isSealed(out.reasoning), isSealed(out.layout), out.stopReason]).toEqual([
      true,
      true,
      "tool_use",
    ]);
    const cap = raw[1]?.payload as Record<string, unknown>;
    expect(isSealed(cap.parts)).toBe(true);
    // ids and a model name stay readable: no content
    expect([cap.stepId, cap.attempt, cap.provider, cap.model]).toEqual([
      "conv#o1#turn:0",
      1,
      "anthropic",
      "claude-opus-5-5",
    ]);
    const back = (plain[0]?.payload as { output: { reasoning: unknown; layout: unknown } }).output;
    expect([back.reasoning, back.layout]).toEqual([reasoning, layout]);
    expect((plain[1]?.payload as { parts: unknown }).parts).toEqual(captured.parts);
  });

  it("seals the message text and leaves the record's shape readable, and the store opens it again", async () => {
    const record = {
      turn: 1,
      ord: 1,
      role: "user",
      text: "a confidential question about Nocturne",
      status: "complete",
    };
    const { raw, plain } = await roundTrip(EXEC, [
      {
        eventType: "DECISION_RECORDED",
        payload: { decisionId: "conv#o1:user", source: "conversation-record", choice: record },
      },
    ]);
    const choice = (raw[0]?.payload as { choice: Record<string, unknown> }).choice;
    expect(isSealed(choice.text)).toBe(true);
    expect([choice.turn, choice.ord, choice.role, choice.status]).toEqual([
      1,
      1,
      "user",
      "complete",
    ]);
    expect((plain[0]?.payload as { choice: unknown }).choice).toEqual(record);
  });

  it("tolerates decisions whose choice is a boolean, a string or a verdict, and seals a tool failure's feedback", async () => {
    const failed = {
      __loomTainted: { origin: "tool" },
      value: { error: "RangeError: the boom carries text" },
    };
    const { raw, plain } = await roundTrip(EXEC, [
      {
        eventType: "DECISION_RECORDED",
        payload: { decisionId: "conv#o1#abort:t0:turn", choice: false },
      },
      {
        eventType: "DECISION_RECORDED",
        payload: { decisionId: "conv#fit:1", choice: { dropCount: 0 } },
      },
      {
        eventType: "DECISION_RECORDED",
        payload: { decisionId: "conv#o1#turn:0:tool:0:outcome", choice: { failed } },
      },
    ]);
    expect((raw[0]?.payload as { choice: unknown }).choice).toBe(false);
    expect((raw[1]?.payload as { choice: unknown }).choice).toEqual({ dropCount: 0 });
    expect(isSealed((raw[2]?.payload as { choice: { failed: unknown } }).choice.failed)).toBe(true);
    expect((plain[2]?.payload as { choice: { failed: unknown } }).choice.failed).toEqual(failed);
  });

  it("seals the model request and reply, a tool's argument text and a tainted tool result", async () => {
    const result = {
      __loomTainted: { origin: "document" },
      value: { passages: [{ text: "passage text" }] },
    };
    const { raw, plain } = await roundTrip(EXEC, [
      {
        eventType: "STEP_STARTED",
        payload: {
          stepId: "conv#o1#turn:0",
          input: { messages: [{ role: "user", content: "q" }], system: "static prompt" },
        },
      },
      {
        eventType: "STEP_COMPLETED",
        payload: {
          stepId: "conv#o1#turn:0",
          output: {
            content: "a",
            toolCalls: [{ id: "t1", name: "search_docs", input: { query: "q" } }],
            stopReason: "tool_use",
          },
        },
      },
      {
        eventType: "STEP_STARTED",
        payload: { stepId: "conv#o1#turn:0:tool:0", input: { query: "Nocturne forecast" } },
      },
      { eventType: "STEP_COMPLETED", payload: { stepId: "conv#o1#turn:0:tool:0", output: result } },
    ]);
    const p = (i: number) =>
      raw[i]?.payload as { input: Record<string, unknown>; output: Record<string, unknown> };
    expect(isSealed(p(0).input.messages)).toBe(true);
    expect(p(0).input.system).toBe("static prompt"); // the prompt is source code, not content
    expect(isSealed(p(1).output.content)).toBe(true);
    expect(isSealed((p(1).output.toolCalls as { input: unknown }[])[0]?.input)).toBe(true);
    expect((p(1).output.toolCalls as { name: string }[])[0]?.name).toBe("search_docs");
    expect(isSealed(p(2).input.query)).toBe(true);
    expect(isSealed(p(3).output.value)).toBe(true);
    expect(plain[3]?.payload).toEqual({ stepId: "conv#o1#turn:0:tool:0", output: result });
  });

  it("seals the carry of a later generation", async () => {
    const input = {
      v: 1,
      seq: 2,
      ord: 2,
      turns: [{ n: 1, user: "question one", assistant: "answer one", status: "complete" }],
      pending: { payload: "x" },
    };
    const { raw } = await roundTrip(`${EXEC}~1`, [
      { eventType: "EXECUTION_STARTED", payload: { input, principal: { v: 1 } } },
    ]);
    const i = (
      raw[0]?.payload as {
        input: { turns: Record<string, unknown>[]; seq: number; pending: unknown };
      }
    ).input;
    expect(
      isSealed(i.turns[0]?.user) && isSealed(i.turns[0]?.assistant) && isSealed(i.pending),
    ).toBe(true);
    expect([i.seq, i.turns[0]?.n, i.turns[0]?.status]).toEqual([2, 1, "complete"]);
  });

  it("leaves an ingest execution's events untouched", async () => {
    const ingest = `u_${U}:ingest-${C}`;
    const input = { tenantId: "t", userId: U, documentId: C };
    const { raw } = await roundTrip(ingest, [
      { eventType: "EXECUTION_STARTED", payload: { input } },
      {
        eventType: "STEP_COMPLETED",
        payload: { stepId: "ingest-parse", output: { outcome: "done", count: 1 } },
      },
    ]);
    expect(raw[0]?.payload).toEqual({ input });
    expect(raw[1]?.payload).toEqual({
      stepId: "ingest-parse",
      output: { outcome: "done", count: 1 },
    });
  });
});
