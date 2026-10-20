import type { FakeAnthropic, FakeReply, FakeRequest } from "@docmind/llm-anthropic/testing";
import type { openSse } from "../documents/testHarness";

/** One sentence, one chunk: the fake embedder hashes words, so a query made of this sentence finds this chunk. */
export const SENTENCE = "Payment terms: payment is due within 30 days of the invoice date.";
export const DOC = `${SENTENCE} Late payment accrues two percent interest per month.`;
/** A thinking-block signature long enough for the event-log proof's 12-character scan. */
export const SIG = "sigA-Zq8Lm2Vx9Rt4Ns6Hd1Wk3Pf7";

export interface Frame {
  event: string;
  id?: string;
  data: unknown;
}

/** One SSE frame as `openSse().next()` returns it; null for the retry hint and heartbeats. */
export function parseFrame(raw: string): Frame | null {
  const lines = raw.split("\n");
  const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
  if (!event) return null;
  const id = lines.find((l) => l.startsWith("id: "))?.slice(4);
  const data = lines.find((l) => l.startsWith("data: "));
  return {
    event,
    ...(id !== undefined && { id }),
    data: data ? JSON.parse(data.slice(6)) : undefined,
  };
}

/** Reads frames until `done` says so; returns all of them. A stream that ends rejects; the test's own timeout bounds a silent one. */
export async function collectUntil(
  stream: Awaited<ReturnType<typeof openSse>>,
  done: (frame: Frame, all: readonly Frame[]) => boolean,
): Promise<Frame[]> {
  const all: Frame[] = [];
  for (;;) {
    const frame = parseFrame(await stream.next());
    if (!frame) continue;
    all.push(frame);
    if (done(frame, all)) return all;
  }
}

export const isReply = (f: Frame): boolean =>
  f.event === "message" && (f.data as { role?: string }).role === "assistant";

/** The first model request of a turn: summarized thinking, then one `search_docs` call. */
export const searchTurn = (id = "toolu_1"): FakeReply => ({
  stream: {
    steps: [
      { thinking: "I should look for the payment terms." },
      { signature: SIG },
      { toolUse: { id, name: "search_docs", input: { query: SENTENCE } } },
      { stop: "tool_use" },
    ],
    usage: { inputTokens: 120, outputTokens: 30 },
  },
});

export const hasToolResult = (body: FakeRequest["body"]): boolean =>
  body.messages.some((m) => m.content.some((b) => b.type === "tool_result"));

/**
 * Scripts the chat model: the title model gets a title; a request with no tool result yet gets the search; the one
 * after the tool result gets `final(body)`.
 */
export function scriptChat(
  claude: FakeAnthropic,
  final: (body: FakeRequest["body"]) => FakeReply,
): void {
  claude.reply((body) => {
    if (body.model === "title-model") return { text: "Payment due dates" };
    return hasToolResult(body) ? final(body) : searchTurn();
  });
}
