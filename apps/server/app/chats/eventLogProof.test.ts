import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { assertNoPlaintext, sealedPaths } from "./eventLogProof";

const ev = (eventType: string, payload: unknown): EventEnvelope =>
  ({
    id: "e",
    executionId: "x",
    workflowId: "w",
    eventType,
    sequence: 0,
    timestamp: 0,
    payload,
  }) as EventEnvelope;
const ENV = { __loomEnc: "loom/aes-256-gcm", iv: "aXY=", tag: "dGFn", data: "ZGF0YQ==" };

describe("assertNoPlaintext", () => {
  it("passes when the secrets appear nowhere", () => {
    expect(() =>
      assertNoPlaintext([ev("A", { x: ENV })], ["a confidential question"]),
    ).not.toThrow();
  });

  it("fails when a secret is in the payload, a key, or the envelope", () => {
    for (const e of [
      ev("A", { choice: { text: "a confidential question" } }),
      ev("A", { "a confidential question": 1 }),
      ev("a confidential question", {}),
    ]) {
      expect(() => assertNoPlaintext([e], ["a confidential question"])).toThrow(
        /appears in the raw event log/,
      );
    }
  });

  it("refuses a secret too short to mean anything, without echoing it", () => {
    expect(() => assertNoPlaintext([], ["short"])).toThrow(
      /^every secret must be at least 12 characters$/,
    );
  });

  it("does not echo the secret it found", () => {
    expect.assertions(1);
    try {
      assertNoPlaintext([ev("A", { t: "a confidential question" })], ["a confidential question"]);
    } catch (err) {
      expect((err as Error).message).not.toContain("confidential");
    }
  });
});

describe("sealedPaths", () => {
  it("lists where envelopes sit, per event type, with array indexes folded to []", () => {
    const paths = sealedPaths([
      ev("STEP_COMPLETED", {
        output: { content: ENV, toolCalls: [{ input: ENV }, { input: ENV }] },
      }),
      ev("MESSAGE_CONSUMED", { payload: ENV }),
      ev("STEP_STARTED", { input: { system: "plain" } }),
    ]);
    expect([...paths].sort()).toEqual([
      "MESSAGE_CONSUMED:payload",
      "STEP_COMPLETED:output.content",
      "STEP_COMPLETED:output.toolCalls[].input",
    ]);
  });
});
