import type { ChatReasoningDto, ChatToolStep, Citation } from "@docmind/contracts";
import { checkKindValue } from "@loom-ui/core/browser";
import type { ChatValue } from "@loom-ui/core/chat-ui";
import { describe, expect, it } from "vitest";
import type { Extras } from "./feedAdapter";
import { toTranscript } from "./transcript";

const P = "c0ffee00-0000-4000-8000-000000000001";
const cite = (id: string): Citation => ({
  passageId: id,
  documentId: "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11",
  docTitle: "Doc",
  locator: { kind: "page", page: 1 },
  snippet: "s",
});
const step: ChatToolStep = { name: "search_docs", label: "Searched documents", count: 8 };
const extras = (o: Partial<Extras> = {}): Extras => ({
  ord: 2,
  citations: [],
  steps: [],
  reasoning: null,
  outcome: null,
  ...o,
});
const value = (over: Record<string, unknown> = {}): ChatValue =>
  ({
    entries: [
      { id: "m1", turn: 1, role: "user", status: "complete", parts: [{ type: "text", text: "q" }] },
      {
        id: "t1.assistant",
        turn: 1,
        role: "assistant",
        status: "complete",
        parts: [{ type: "text", text: `a [[${P}]]` }],
        ...over,
      },
    ],
  }) as ChatValue;
const fold = (x: Extras | undefined, live: ChatToolStep[] = [], older: string | null = null) => ({
  extrasOf: (id: string) => (id === "t1.assistant" ? x : undefined),
  liveSteps: live,
  olderCursor: older,
});
const reply = (v: ChatValue) => v.entries[1] as NonNullable<ChatValue["entries"][number]>;

describe("toTranscript", () => {
  it("adds one tool line per durable step, and the live steps while the reply streams", () => {
    expect(reply(toTranscript(value(), fold(extras({ steps: [step] })))).tools).toEqual([
      { name: "Searched documents (8)", status: "done" },
    ]);
    const live = toTranscript(value({ status: "streaming" }), fold(extras(), [step, step]));
    expect(reply(live).tools).toHaveLength(2);
  });
  it("shows the stored reasoning when the feed has none, keeps live reasoning, and never gives text to a redacted one", () => {
    const stored: ChatReasoningDto = { text: "I looked", kind: "summary" };
    expect(reply(toTranscript(value(), fold(extras({ reasoning: stored })))).reasoning).toEqual({
      text: "I looked",
      kind: "summary",
      streaming: false,
    });
    const liveR = { text: "live", kind: "summary" as const, streaming: true };
    expect(
      reply(toTranscript(value({ reasoning: liveR }), fold(extras({ reasoning: stored }))))
        .reasoning,
    ).toEqual(liveR);
    expect(
      reply(
        toTranscript(value(), fold(extras({ reasoning: { text: "hidden", kind: "redacted" } }))),
      ).reasoning,
    ).toEqual({ text: "", kind: "redacted", streaming: false });
  });
  it("lists the cited passage ids once each, and none while the reply is still streaming", () => {
    const x = extras({ citations: [cite(P), cite(P)] });
    expect(reply(toTranscript(value(), fold(x))).refs).toEqual([{ id: P }]);
    expect(reply(toTranscript(value({ status: "streaming" }), fold(x))).refs).toBeUndefined();
    expect(toTranscript(value(), fold(x)).refMarkers).toBe(true);
  });
  it("leaves user and restricted entries alone and takes `older` from the fold when it is a cursor", () => {
    const out = toTranscript(value(), fold(extras({ citations: [cite(P)] }), [], "1.5"));
    expect(out.entries[0]).toEqual(value().entries[0]);
    expect(out.older).toBe("1.5");
    expect(toTranscript(value(), fold(undefined, [], "not a cursor")).older).toBeUndefined();
    const restricted = {
      entries: [{ id: "t1.assistant", turn: 1, role: "assistant", status: "restricted" }],
    } as ChatValue;
    expect(toTranscript(restricted, fold(extras({ steps: [step] }))).entries[0]).toEqual(
      restricted.entries[0],
    );
  });
  it("is a valid Chat value, which loom-ui checks before it draws", () => {
    const out = toTranscript(
      value(),
      fold(
        extras({
          steps: [step],
          citations: [cite(P)],
          reasoning: { text: "I looked", kind: "summary" },
        }),
        [],
        "1.5",
      ),
    );
    expect(checkKindValue("Chat", out).ok).toBe(true);
  });
  it("keeps a part's markdown format, so the flag the fold set reaches the renderer", () => {
    const md = value({ parts: [{ type: "text", text: "a **b**", format: "markdown" }] });
    const out = toTranscript(md, fold(extras()));
    expect(reply(out).parts).toEqual([{ type: "text", text: "a **b**", format: "markdown" }]);
    expect(checkKindValue("Chat", out).ok).toBe(true);
  });
});
