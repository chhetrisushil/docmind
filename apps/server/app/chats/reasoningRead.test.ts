import { ReasoningResponse } from "@docmind/contracts";
import { tainted } from "@loom/classify";
import { ConversationNotFoundError } from "@loom/conversation";
import { type LlmReasoning, type ReasoningStepRead, captureReasoning } from "@loom/llm";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { chatConversationId } from "./ids";
import {
  MAX_REASONING_CHARS,
  REPLY_LIMITS,
  foldReasoning,
  memoLog,
  reasoningBody,
  replyReasoning,
} from "./reasoningRead";
import { ChatReasoningStore } from "./reasoningStore";
import { type ChatCallScope, chatScope } from "./scope";
import { C, MemoryReasoningRows, T, U, modelCtx } from "./testing";

const CONV = chatConversationId(U, C);
const REF = { tenantId: T, userId: U, chatId: C };
const part = (kind: "text" | "summary" | "redacted", status: string, text?: string) => ({
  kind,
  provider: "anthropic",
  status,
  ...(text !== undefined && { text: tainted(text, "llm-reasoning:s") }),
});
const step = (
  stepId: string,
  attempts: { attempt: number; recorded: boolean; parts: ReturnType<typeof part>[] }[],
  recordedAttempt?: number,
): ReasoningStepRead =>
  ({
    stepId,
    attempts: attempts.map((a) => ({ provider: "anthropic", ...a })),
    ...(recordedAttempt !== undefined && { recordedAttempt }),
  }) as unknown as ReasoningStepRead;

describe("foldReasoning", () => {
  it("joins the recorded attempts' texts with a blank line, and is a summary when any part is one", () => {
    const got = foldReasoning(
      [
        step(
          "conv#o1#turn:0",
          [{ attempt: 1, recorded: true, parts: [part("text", "ok", "first ")] }],
          1,
        ),
        step(
          "conv#o1#turn:1",
          [{ attempt: 1, recorded: true, parts: [part("summary", "ok", "second")] }],
          1,
        ),
      ],
      false,
    );
    expect(got).toEqual({ text: "first\n\nsecond", kind: "summary" });
  });

  it("ignores a superseded attempt", () => {
    const got = foldReasoning(
      [
        step(
          "conv#o1#turn:0",
          [
            { attempt: 1, recorded: false, parts: [part("summary", "ok", "retried away")] },
            { attempt: 2, recorded: true, parts: [part("summary", "ok", "kept")] },
          ],
          2,
        ),
      ],
      false,
    );
    expect(got).toEqual({ text: "kept", kind: "summary" });
  });

  it("reads hidden, erased and mismatching parts as markers, text winning over them", () => {
    const only = (...parts: ReturnType<typeof part>[]) =>
      foldReasoning([step("s", [{ attempt: 1, recorded: true, parts }], 1)], false);
    expect(only(part("redacted", "redacted"))).toEqual({ text: "", kind: "redacted" });
    expect(only(part("text", "ok", "   "))).toEqual({ text: "", kind: "redacted" }); // an omitted-display block
    expect(only(part("summary", "erased"))).toEqual({ text: "", kind: "text", status: "erased" });
    expect(only(part("summary", "digest-mismatch"))).toEqual({
      text: "",
      kind: "text",
      status: "digest-mismatch",
    });
    expect(only(part("summary", "erased"), part("summary", "ok", "left"))).toEqual({
      text: "left",
      kind: "summary",
    });
    expect(only()).toBeNull();
  });

  it("caps the text and says so, and passes the reader's truncation on", () => {
    const long = "x".repeat(MAX_REASONING_CHARS + 500);
    const got = foldReasoning(
      [step("s", [{ attempt: 1, recorded: true, parts: [part("summary", "ok", long)] }], 1)],
      false,
    );
    expect(got?.text).toHaveLength(MAX_REASONING_CHARS);
    expect(got?.truncated).toBe(true);
    expect(
      foldReasoning(
        [step("s", [{ attempt: 1, recorded: true, parts: [part("summary", "ok", "a")] }], 1)],
        true,
      )?.truncated,
    ).toBe(true);
  });
});

/** A log and a store that Loom's own `captureReasoning` writes to, as the model effect does. */
function world() {
  const log: { executionId: string; eventType: string; payload: unknown }[] = [];
  const reads: string[] = [];
  const store = new ChatReasoningStore(
    new MemoryReasoningRows(),
    new FieldCrypto(new InMemoryKeyStore()),
  );
  const scope = (stepKey: string): ChatCallScope => ({ ...REF, turnKey: 1, stepKey, attempt: 1 });
  const record = async (
    executionId: string,
    stepId: string,
    reasoning: LlmReasoning[],
    o: { attempt?: number; complete?: boolean } = {},
  ) => {
    const ctx = modelCtx({
      executionId,
      stepId,
      attempt: o.attempt ?? 1,
      emit: (eventType, payload) => log.push({ executionId, eventType, payload }),
    });
    await chatScope.run(scope(stepId), () =>
      captureReasoning(reasoning, { store, model: "m" }, ctx),
    );
    if (o.complete !== false)
      log.push({ executionId, eventType: "STEP_COMPLETED", payload: { stepId } });
  };
  const reader = {
    read: async (id: string) => {
      reads.push(id);
      if (id.endsWith("~9")) throw new RangeError("the log is down");
      return log.filter((e) => e.executionId === id);
    },
  };
  return { record, reader, reads, store };
}
const summary = (text: string): LlmReasoning => ({
  kind: "summary",
  text,
  signature: "S",
  provider: "anthropic",
});

describe("replyReasoning", () => {
  it("reads each execution's log once per request, gives each reply its own turn's reasoning, and null for none", async () => {
    const w = world();
    await w.record(CONV, "conv#o1#turn:0", [summary("turn one, frame one")]);
    await w.record(CONV, "conv#o1#turn:1", [summary("turn one, frame two")]);
    await w.record(CONV, "conv#o2#turn:0", [summary("turn two")]);
    await w.record(`${CONV}~1`, "conv#o3#turn:0", [summary("turn three, next generation")]);
    const reasoning = replyReasoning({ log: w.reader, store: w.store });
    const got = await reasoning.forReplies(REF, CONV, [
      { cursor: "0.2", turnKey: 1 },
      { cursor: "0.4", turnKey: 2 },
      { cursor: "0.6", turnKey: 5 }, // no reasoning recorded for this one
      { cursor: "1.2", turnKey: 3 },
    ]);
    expect([...got.entries()]).toEqual([
      ["0.2", { text: "turn one, frame one\n\nturn one, frame two", kind: "summary" }],
      ["0.4", { text: "turn two", kind: "summary" }],
      ["0.6", null],
      ["1.2", { text: "turn three, next generation", kind: "summary" }],
    ]);
    expect([...w.reads].sort()).toEqual([CONV, `${CONV}~1`].sort()); // one read per generation, not per reply
  });

  it("does not mix a reply up with a later turn whose key starts with the same digits", async () => {
    const w = world();
    await w.record(CONV, "conv#o1#turn:0", [summary("one")]);
    await w.record(CONV, "conv#o10#turn:0", [summary("ten")]);
    const got = await replyReasoning({ log: w.reader, store: w.store }).forReplies(REF, CONV, [
      { cursor: "0.2", turnKey: 1 },
    ]);
    expect(got.get("0.2")).toEqual({ text: "one", kind: "summary" });
  });

  it("gives null for a bad cursor, and for a reply whose generation cannot be read, without failing the others", async () => {
    const w = world();
    await w.record(CONV, "conv#o1#turn:0", [summary("fine")]);
    const errors: unknown[] = [];
    const got = await replyReasoning({
      log: w.reader,
      store: w.store,
      onError: (e) => errors.push(e),
    }).forReplies(REF, CONV, [
      { cursor: "0.2", turnKey: 1 },
      { cursor: "nonsense", turnKey: 1 },
      { cursor: "9.2", turnKey: 4 }, // generation 9: the log read fails
    ]);
    expect([got.get("0.2"), got.get("nonsense"), got.get("9.2")]).toEqual([
      { text: "fine", kind: "summary" },
      null,
      null,
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RangeError);
  });

  it("bounds the parts read for one reply and says the text is truncated", async () => {
    const w = world();
    for (let i = 0; i < REPLY_LIMITS.maxParts + 1; i++)
      await w.record(CONV, `conv#o1#turn:${i}`, [summary(`p${i}`)]);
    const got = await replyReasoning({ log: w.reader, store: w.store }).forReplies(REF, CONV, [
      { cursor: "0.2", turnKey: 1 },
    ]);
    expect(got.get("0.2")?.truncated).toBe(true);
    expect(got.get("0.2")?.text.startsWith("p0\n\np1")).toBe(true);
    expect(got.get("0.2")?.text).not.toContain(`p${REPLY_LIMITS.maxParts}`);
  });
});

describe("memoLog", () => {
  it("reads an execution once however often it is asked", async () => {
    let n = 0;
    const log = memoLog({
      read: async () => {
        n++;
        return [];
      },
    });
    await Promise.all([log.read("a"), log.read("a"), log.read("b")]);
    await log.read("a");
    expect(n).toBe(2);
  });
});

describe("reasoningBody", () => {
  const options = { principal: { tenant: T, actor: U } };

  it("returns Loom's body shape for the reply the conversation names, text unwrapped, every attempt kept", async () => {
    const w = world();
    await w.record(CONV, "conv#o1#turn:0", [summary("superseded")], {
      attempt: 1,
      complete: false,
    });
    await w.record(
      CONV,
      "conv#o1#turn:0",
      [summary("recorded"), { kind: "redacted", signature: "ENC", provider: "anthropic" }],
      { attempt: 2 },
    );
    await w.record(CONV, "conv#o2#turn:0", [summary("another turn")]);
    const calls: unknown[] = [];
    const body = await reasoningBody(
      {
        conversations: {
          reasoningTarget: async (id, cursor) => {
            calls.push([id, cursor]);
            return { executionId: CONV, stepPrefix: "conv#o1#" };
          },
        },
        log: w.reader,
        store: w.store,
      },
      REF,
      CONV,
      "0.2",
      options,
    );
    expect(calls).toEqual([[CONV, "0.2"]]);
    expect(ReasoningResponse.parse(body)).toEqual({
      steps: [
        {
          stepId: "conv#o1#turn:0",
          recordedAttempt: 2,
          attempts: [
            {
              attempt: 1,
              provider: "anthropic",
              model: "m",
              recorded: false,
              parts: [{ kind: "summary", status: "ok", text: "superseded" }],
            },
            {
              attempt: 2,
              provider: "anthropic",
              model: "m",
              recorded: true,
              parts: [
                { kind: "summary", status: "ok", text: "recorded" },
                { kind: "redacted", status: "redacted" },
              ],
            },
          ],
        },
      ],
    });
  });

  it("lets the conversation's refusal through: another reader, an unknown cursor and a user message are all not found", async () => {
    const w = world();
    const refusing = {
      reasoningTarget: async (id: string) => {
        throw new ConversationNotFoundError(id);
      },
    };
    await expect(
      reasoningBody(
        { conversations: refusing, log: w.reader, store: w.store },
        REF,
        CONV,
        "0.1",
        options,
      ),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(w.reads).toEqual([]); // nothing was read before the audience decision
  });
});
