import type { LlmUsageDetail, RefusalDetails } from "../observer";

export type StreamStep =
  | { thinking: string }
  | { text: string }
  | { toolUse: { id: string; name: string; input: unknown } }
  | { signature: string }
  | { stop: "end_turn" | "tool_use" | "max_tokens" | "refusal"; details?: RefusalDetails }
  | { error: "overloaded_error" | "api_error" }
  | { hold: true }; // pause after the previous event until FakeAnthropic.streamHold() is released

export interface StreamScript {
  steps: readonly StreamStep[];
  usage?: Partial<LlmUsageDetail>;
}

type Node =
  | { kind: "thinking"; text: string; signature: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown }
  | { kind: "hold" }
  | { kind: "error"; error: "overloaded_error" | "api_error" };

export interface Normal {
  nodes: Node[];
  /** Set when the script has an `error` step. */
  failure?: "overloaded_error" | "api_error";
  stop: "end_turn" | "tool_use" | "max_tokens" | "refusal";
  details?: RefusalDetails;
  usage: LlmUsageDetail;
}

export type SseItem = { event: string; data: unknown } | { hold: true };

/** Folds a script's steps into blocks, a stop and usage. `inputTokens` is the fake's default. */
export function normalize(script: StreamScript, inputTokens: number): Normal {
  const nodes: Node[] = [];
  let stop: Normal["stop"] | undefined;
  let details: RefusalDetails | undefined;
  for (const s of script.steps) {
    if ("thinking" in s) {
      nodes.push({ kind: "thinking", text: s.thinking, signature: "fake-signature" });
    } else if ("signature" in s) {
      const last = nodes.at(-1);
      if (s.signature === "") throw new Error("a signature must not be empty");
      if (last?.kind !== "thinking")
        throw new Error("a signature step must follow a thinking step");
      last.signature = s.signature;
    } else if ("text" in s) {
      nodes.push({ kind: "text", text: s.text });
    } else if ("toolUse" in s) {
      nodes.push({ kind: "tool", id: s.toolUse.id, name: s.toolUse.name, input: s.toolUse.input });
    } else if ("stop" in s) {
      stop = s.stop;
      details = s.details;
    } else if ("error" in s) {
      nodes.push({ kind: "error", error: s.error });
    } else {
      nodes.push({ kind: "hold" });
    }
  }
  const failed = nodes.find((n) => n.kind === "error");
  const u = script.usage ?? {};
  return {
    nodes,
    ...(failed?.kind === "error" && { failure: failed.error }),
    stop: stop ?? (nodes.some((n) => n.kind === "tool") ? "tool_use" : "end_turn"),
    ...(details !== undefined && { details }),
    usage: {
      inputTokens: u.inputTokens ?? inputTokens,
      outputTokens: u.outputTokens ?? 1,
      cacheReadTokens: u.cacheReadTokens ?? 0,
      cacheWriteTokens: u.cacheWriteTokens ?? 0,
    },
  };
}

const apiUsage = (u: LlmUsageDetail) => ({
  input_tokens: u.inputTokens,
  output_tokens: u.outputTokens,
  cache_read_input_tokens: u.cacheReadTokens,
  cache_creation_input_tokens: u.cacheWriteTokens,
});
const stopDetails = (n: Normal) =>
  n.stop === "refusal" ? { type: "refusal", ...n.details } : null;

/** Two pieces, so a consumer has to accumulate deltas. */
const halves = (s: string): string[] => {
  const a = Array.from(s);
  const m = Math.ceil(a.length / 2);
  return [a.slice(0, m).join(""), a.slice(m).join("")].filter((p) => p !== "");
};

/** The same script as a non-streaming message. */
export function renderJson(n: Normal, model: string): unknown {
  const content = n.nodes.flatMap((x): object[] => {
    if (x.kind === "thinking")
      return [{ type: "thinking", thinking: x.text, signature: x.signature }];
    if (x.kind === "text") return [{ type: "text", text: x.text }];
    if (x.kind === "tool") return [{ type: "tool_use", id: x.id, name: x.name, input: x.input }];
    return [];
  });
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: n.stop,
    stop_details: stopDetails(n),
    usage: apiUsage(n.usage),
  };
}

/** The script as Messages API streaming events (plus hold markers). */
export function renderEvents(n: Normal, model: string): SseItem[] {
  const items: SseItem[] = [];
  const push = (type: string, o: object = {}) => items.push({ event: type, data: { type, ...o } });
  push("message_start", {
    message: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage: { ...apiUsage(n.usage), output_tokens: 1 },
    },
  });
  push("ping");
  let index = 0;
  for (const node of n.nodes) {
    if (node.kind === "hold") {
      items.push({ hold: true });
      continue;
    }
    if (node.kind === "error") {
      push("error", { error: { type: node.error, message: "fake error" } });
      return items;
    }
    const i = index++;
    const delta = (d: object) => push("content_block_delta", { index: i, delta: d });
    if (node.kind === "thinking") {
      push("content_block_start", { index: i, content_block: { type: "thinking", thinking: "" } });
      for (const t of halves(node.text)) delta({ type: "thinking_delta", thinking: t });
      delta({ type: "signature_delta", signature: node.signature });
    } else if (node.kind === "text") {
      push("content_block_start", { index: i, content_block: { type: "text", text: "" } });
      for (const t of halves(node.text)) delta({ type: "text_delta", text: t });
    } else {
      push("content_block_start", {
        index: i,
        content_block: { type: "tool_use", id: node.id, name: node.name, input: {} },
      });
      const json = JSON.stringify(node.input ?? {});
      if (json !== "{}")
        for (const p of halves(json)) delta({ type: "input_json_delta", partial_json: p });
    }
    push("content_block_stop", { index: i });
  }
  push("message_delta", {
    delta: { stop_reason: n.stop, stop_details: stopDetails(n) },
    usage: { output_tokens: n.usage.outputTokens },
  });
  push("message_stop");
  return items;
}
