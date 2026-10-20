import type { LlmStreamChunk, LlmToolCall } from "@loom/llm";
import { LlmRequestError, LlmStreamError } from "./errors";
import {
  type StopReason,
  type UsageFields,
  mapStopReason,
  refusalDetailsOf,
  usageDetail,
  usageFieldsOf,
} from "./mapping";
import type { LlmUsageDetail, ReasoningBlock, RefusalDetails } from "./observer";

type Open =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; json: string }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted"; data: string }
  | { kind: "ignored" };

export interface StreamEnd {
  stopReason: StopReason;
  /** Set when the API stopped with `refusal`: the tool calls and blocks below are then empty. */
  refused?: RefusalDetails;
  toolCalls: LlmToolCall[];
  /** The response's full content blocks (thinking, redacted_thinking, text, tool_use), verbatim, in the order the API produced them (ruling P1). */
  blocks: ReasoningBlock[];
  /** True when the response had a `thinking` or `redacted_thinking` block: then, and only then, `onBlocks` is called. */
  sawThinking: boolean;
  usage?: { inputTokens: number; outputTokens: number };
  detail: LlmUsageDetail;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** `error` event types that blame the request: permanent. Everything else is transient. */
const PERMANENT = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
]);

function parseInput(json: string): unknown {
  if (json === "") return {}; // an empty argument object streams as no deltas at all
  try {
    return JSON.parse(json);
  } catch {
    return { __unparsedArguments: json }; // keep it: the agent loop must see why the call failed
  }
}

/**
 * The stream's state machine. `feed` takes one SSE event and returns the chunks it produces;
 * `end` is valid once `stopped` (a `message_stop` arrived). It throws only typed errors with fixed
 * messages: nothing of an event's text reaches an error.
 */
export class StreamState {
  readonly #open = new Map<number, Open>();
  readonly #blocks = new Map<number, ReasoningBlock>();
  readonly #seen = new Set<number>();
  #sawThinking = false;
  #usage: UsageFields = {};
  #stop: unknown;
  #details: unknown;
  stopped = false;

  constructor(private readonly onThinking: (text: string) => void) {}

  feed(event: string, data: string): LlmStreamChunk[] {
    if (event === "ping") return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new LlmRequestError();
    }
    const o = obj(parsed);
    if (!o) throw new LlmRequestError();
    const type = typeof o.type === "string" ? o.type : event;
    const index = Number.isInteger(o.index) ? (o.index as number) : -1;
    switch (type) {
      case "message_start":
        this.#usage = { ...this.#usage, ...usageFieldsOf(obj(o.message)?.usage) };
        return [];
      case "content_block_start": {
        const b = obj(o.content_block);
        if (!b || index < 0 || this.#seen.has(index)) throw new LlmRequestError();
        this.#seen.add(index);
        if (b.type === "text") {
          const first = typeof b.text === "string" ? b.text : "";
          this.#open.set(index, { kind: "text", text: first });
          return first !== "" ? [{ delta: first, done: false }] : [];
        }
        if (b.type === "tool_use") {
          if (typeof b.id !== "string" || typeof b.name !== "string") throw new LlmRequestError();
          this.#open.set(index, { kind: "tool", id: b.id, name: b.name, json: "" });
          return [
            { delta: "", done: false, toolDelta: { id: b.id, name: b.name, inputDelta: "" } },
          ];
        }
        if (b.type === "thinking") {
          const thinking = typeof b.thinking === "string" ? b.thinking : "";
          const signature = typeof b.signature === "string" ? b.signature : "";
          this.#open.set(index, { kind: "thinking", thinking, signature });
          if (thinking !== "") this.onThinking(thinking);
          return [];
        }
        if (b.type === "redacted_thinking") {
          if (typeof b.data !== "string") throw new LlmRequestError();
          this.#open.set(index, { kind: "redacted", data: b.data });
          return [];
        }
        this.#open.set(index, { kind: "ignored" });
        return [];
      }
      case "content_block_delta": {
        const open = this.#open.get(index);
        const d = obj(o.delta);
        if (!open || !d) return [];
        if (open.kind === "text" && d.type === "text_delta" && typeof d.text === "string") {
          open.text += d.text;
          return d.text === "" ? [] : [{ delta: d.text, done: false }];
        }
        if (
          open.kind === "tool" &&
          d.type === "input_json_delta" &&
          typeof d.partial_json === "string"
        ) {
          if (d.partial_json === "") return [];
          open.json += d.partial_json;
          return [
            { delta: "", done: false, toolDelta: { id: open.id, inputDelta: d.partial_json } },
          ];
        }
        if (
          open.kind === "thinking" &&
          d.type === "thinking_delta" &&
          typeof d.thinking === "string"
        ) {
          open.thinking += d.thinking;
          if (d.thinking !== "") this.onThinking(d.thinking);
          return [];
        }
        if (
          open.kind === "thinking" &&
          d.type === "signature_delta" &&
          typeof d.signature === "string"
        ) {
          open.signature += d.signature;
          return [];
        }
        return [];
      }
      case "content_block_stop": {
        const open = this.#open.get(index);
        this.#open.delete(index);
        if (open?.kind === "text" && open.text !== "") {
          this.#blocks.set(index, { type: "text", text: open.text });
        }
        if (open?.kind === "tool") {
          const input = parseInput(open.json);
          this.#blocks.set(index, { type: "tool_use", id: open.id, name: open.name, input });
        }
        if (open?.kind === "redacted") {
          this.#sawThinking = true;
          this.#blocks.set(index, { type: "redacted_thinking", data: open.data });
        }
        if (open?.kind === "thinking") {
          if (open.signature === "") throw new LlmRequestError();
          this.#sawThinking = true;
          this.#blocks.set(index, {
            type: "thinking",
            thinking: open.thinking,
            signature: open.signature,
          });
        }
        return [];
      }
      case "message_delta": {
        const d = obj(o.delta);
        if (typeof d?.stop_reason === "string") {
          this.#stop = d.stop_reason;
          this.#details = d.stop_details;
        }
        this.#usage = { ...this.#usage, ...usageFieldsOf(o.usage) };
        return [];
      }
      case "message_stop":
        this.stopped = true;
        return [];
      case "error":
        // The event's message is the model's or the platform's text: never read into an error.
        throw PERMANENT.has(String(obj(o.error)?.type))
          ? new LlmRequestError()
          : new LlmStreamError();
      default:
        return []; // unknown events are ignored: the API adds them over time
    }
  }

  /** A stream that ended without `message_stop` and a stop reason is truncated: transient. */
  end(): StreamEnd {
    if (!this.stopped || typeof this.#stop !== "string") throw new LlmStreamError();
    if (this.#open.size > 0) throw new LlmRequestError(); // a block never stopped
    const ordered = [...this.#blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    const toolCalls: LlmToolCall[] = ordered.flatMap((b) =>
      b.type === "tool_use" ? [{ id: b.id as string, name: b.name as string, input: b.input }] : [],
    );
    const refused = this.#stop === "refusal" ? refusalDetailsOf(this.#details) : undefined;
    const u = this.#usage;
    return {
      stopReason: mapStopReason(this.#stop),
      ...(refused !== undefined && { refused }),
      toolCalls: refused ? [] : toolCalls,
      blocks: refused ? [] : ordered,
      sawThinking: refused ? false : this.#sawThinking,
      ...(u.input !== undefined &&
        u.output !== undefined && { usage: { inputTokens: u.input, outputTokens: u.output } }),
      detail: usageDetail(u),
    };
  }
}
