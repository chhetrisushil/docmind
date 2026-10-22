import { unwrapTainted } from "@loom/classify";
import { UNTRUSTED_CONTENT_SYSTEM_NOTE, readReasoningBounded } from "@loom/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompatReply } from "../llm/testing";
import { DOC_ASSISTANT_PROMPT } from "./agent";
import { chatConversationId } from "./ids";
import { type ChatStack, startOllamaChatStack } from "./testStack";
import { C, T, U } from "./testing";
import { passage } from "./tools/testing";

const CONV = chatConversationId(U, C);
const QUESTION = "What is the Nocturne revenue forecast for next quarter?";
const PASSAGE = passage({
  text: "Nocturne quarterly revenue forecast: seventeen thousand dollars.",
  docTitle: "Memo",
});
const PROVIDER_MESSAGE = "sentinel-provider-message";
const THOUGHT = "sentinel-thought-1";

type Stack = ChatStack<Awaited<ReturnType<typeof startOllamaChatStack>>["fake"]>;
let stack: Stack | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await stack?.close();
  stack = undefined;
});

const rawLog = async (s: Pick<Stack, "raw">) =>
  JSON.stringify(await Promise.all((await s.raw.listExecutions()).map((e) => s.raw.read(e))));

const ok =
  (text: string): (() => CompatReply) =>
  () => ({ kind: "text", text });

describe("the chat on Ollama (fake)", () => {
  it("runs a tool loop with reasoning reaching the hub and the sealed store, and never logs the thinking", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await startOllamaChatStack({
      passages: [PASSAGE],
      replies: [
        () => ({
          kind: "tools",
          calls: [{ name: "search_docs", input: { query: "sentinel-query" } }],
          reasoning: THOUGHT,
        }),
        () => ({
          kind: "text",
          text: `sentinel answer [[${PASSAGE.passageId}]]`,
          reasoning: "sentinel-thought-2",
        }),
      ],
    });
    stack = s;
    const id = await s.start();
    const live: string[] = [];
    const off = s.chat.hub.subscribe(id, (ev) => {
      if (ev.type === "reasoning") live.push(ev.text);
    });
    await s.send(id, QUESTION);
    expect(await s.replies(id, 1)).toEqual([
      { text: `sentinel answer [[${PASSAGE.passageId}]]`, status: "complete" },
    ]);
    off();
    expect(live.join("")).toBe("sentinel-thought-1sentinel-thought-2");
    expect(s.fake.requests).toHaveLength(2);
    for (const r of s.fake.requests) {
      const first = (r.body.messages as { role: string; content: string }[])[0];
      expect(first?.role).toBe("system");
      expect(first?.content).toBe(DOC_ASSISTANT_PROMPT);
      expect(first?.content).toContain(UNTRUSTED_CONTENT_SYSTEM_NOTE);
    }
    expect(s.fake.requests[0]?.body).toMatchObject({ stream: true, reasoning_effort: "medium" });
    expect(
      (s.fake.requests[0]?.body.tools as { function: { name: string } }[]).map(
        (t) => t.function.name,
      ),
    ).toContain("search_docs");
    const toolMessage = (
      s.fake.requests[1]?.body.messages as { role: string; content: string }[]
    ).find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("seventeen thousand dollars");
    expect(s.items.puts.filter((p) => p.item.kind === "tool")).toHaveLength(1);
    expect(s.reasoningRows.rows.size).toBe(2);
    const read = await readReasoningBounded(
      s.events,
      s.reasoning.readerFor({ tenantId: T, userId: U, chatId: C }),
      { executionId: CONV, stepPrefix: "conv#o1#" },
    );
    const parts = read.steps.flatMap((st) => st.attempts.flatMap((a) => a.parts));
    expect(parts.map((p) => (p.text === undefined ? undefined : unwrapTainted(p.text)))).toEqual([
      "sentinel-thought-1",
      "sentinel-thought-2",
    ]);
    expect(await rawLog(s)).not.toContain("sentinel-thought");
    const logged = JSON.stringify([...errors.mock.calls, ...warns.mock.calls, ...logs.mock.calls]);
    expect(logged).not.toContain("sentinel-thought");
  });

  it("sends two parallel tool calls back as one assistant message and two matching tool results", async () => {
    const s = await startOllamaChatStack({
      passages: [PASSAGE],
      replies: [
        () => ({
          kind: "tools",
          calls: [
            { name: "search_docs", input: { query: "sentinel-a" } },
            { name: "search_docs", input: { query: "sentinel-b" } },
          ],
        }),
        ok("done"),
      ],
    });
    stack = s;
    const id = await s.start();
    await s.send(id, QUESTION);
    await s.replies(id, 1);
    const msgs = s.fake.requests[1]?.body.messages as {
      role: string;
      tool_calls?: { id: string }[];
      tool_call_id?: string;
    }[];
    const assistant = msgs.find((m) => m.role === "assistant" && m.tool_calls !== undefined);
    const ids = assistant?.tool_calls?.map((c) => c.id) ?? [];
    expect(ids).toEqual(["call_0_0", "call_0_1"]);
    expect(msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(ids);
  });

  it.each([
    ["503", { kind: "error", status: 503 }],
    ["429", { kind: "error", status: 429 }],
    ["a mid-stream cut", { kind: "cutoff", text: "partial ", reasoning: THOUGHT }],
  ] as [string, CompatReply][])(
    "%s ends the turn failed, leaks nothing, and the next turn works",
    async (_name, failure) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const s = await startOllamaChatStack({
        replies: [() => failure, ok("second answer")],
      });
      stack = s;
      const id = await s.start();
      await s.send(id, QUESTION);
      const [first] = await s.replies(id, 1);
      expect(first?.status).toBe("failed");
      expect(JSON.stringify(first)).not.toContain(PROVIDER_MESSAGE);
      const log = await rawLog(s);
      expect(log).not.toContain(PROVIDER_MESSAGE);
      expect(log).not.toContain(QUESTION);
      expect(log).not.toContain(THOUGHT);
      expect(JSON.stringify(errors.mock.calls)).not.toContain(THOUGHT);
      expect(JSON.stringify(errors.mock.calls)).not.toContain(PROVIDER_MESSAGE);

      await s.send(id, "And the one after?");
      const all = await s.replies(id, 2);
      expect(all[1]).toEqual({ text: "second answer", status: "complete" });
    },
  );

  it("a permanent 400 ends the turn failed with a fixed reason after one request, leaks nothing, and the next turn works", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const s = await startOllamaChatStack({
      replies: [() => ({ kind: "error", status: 400 }), ok("second answer")],
    });
    stack = s;
    const id = await s.start();
    await s.send(id, QUESTION);
    const [first] = await s.replies(id, 1);
    expect(first).toMatchObject({ status: "failed", reason: "model-error" });
    expect(s.fake.requests).toHaveLength(1); // permanent: no second attempt
    const opened = JSON.stringify(await s.events.read(CONV));
    // any error text exposed carries at most the HTTP status
    const errorTexts = (JSON.parse(opened) as { payload: { error?: unknown } }[])
      .map((e) => e.payload.error)
      .filter((e) => e !== undefined);
    for (const text of errorTexts)
      expect(text).toMatch(
        /^LlmRequestError: the language model rejected the request \(HTTP 400\)$/,
      );
    expect(opened).not.toContain("EXECUTION_FAILED"); // the conversation survives
    const log = await rawLog(s);
    expect(log).not.toContain(QUESTION); // sealed
    const console_ = JSON.stringify([
      ...errors.mock.calls,
      ...warns.mock.calls,
      ...logs.mock.calls,
    ]);
    for (const view of [JSON.stringify(first), log, opened, console_])
      expect(view).not.toContain(PROVIDER_MESSAGE);
    expect(console_).not.toContain(QUESTION);

    await s.send(id, "And the one after?");
    const all = await s.replies(id, 2);
    expect(all[1]).toEqual({ text: "second answer", status: "complete" });
    expect(s.fake.requests).toHaveLength(2); // the failed turn's one, the next turn's one
  });

  it("a reply cut at max_tokens ends with the max_tokens outcome item", async () => {
    const s = await startOllamaChatStack({
      replies: [() => ({ kind: "text", text: "sentinel cut", finish: "length" })],
    });
    stack = s;
    const id = await s.start();
    await s.send(id, QUESTION);
    await s.replies(id, 1);
    expect(s.items.puts.filter((p) => p.item.kind === "outcome").map((p) => p.item)).toEqual([
      { kind: "outcome", body: { kind: "max_tokens" } },
    ]);
  });
});
