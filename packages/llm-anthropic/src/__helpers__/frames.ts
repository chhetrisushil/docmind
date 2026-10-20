/** SSE frames of the Messages streaming API, as the tests need them. */
export const event = (type: string, o: object = {}): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;

export const start = (usage: object = { input_tokens: 5, output_tokens: 1 }): string =>
  event("message_start", { message: { id: "msg_t", role: "assistant", content: [], usage } });
export const ping = (): string => event("ping");
export const open = (index: number, content_block: object): string =>
  event("content_block_start", { index, content_block });
export const delta = (index: number, d: object): string =>
  event("content_block_delta", { index, delta: d });
export const close = (index: number): string => event("content_block_stop", { index });
export const end = (
  stop_reason: string,
  usage: object = { output_tokens: 7 },
  stop_details?: object,
): string =>
  event("message_delta", {
    delta: { stop_reason, ...(stop_details && { stop_details }) },
    usage,
  });
export const stop = (): string => event("message_stop");
/** An `error` event whose message is a marker no error of ours may carry. */
export const error = (kind: string): string =>
  event("error", { error: { type: kind, message: "SECRET-MODEL-TEXT" } });

export const text = (index: number, ...pieces: string[]): string[] => [
  open(index, { type: "text", text: "" }),
  ...pieces.map((t) => delta(index, { type: "text_delta", text: t })),
  close(index),
];
export const tool = (index: number, id: string, name: string, ...json: string[]): string[] => [
  open(index, { type: "tool_use", id, name, input: {} }),
  ...json.map((j) => delta(index, { type: "input_json_delta", partial_json: j })),
  close(index),
];
export const thinking = (index: number, pieces: string[], signature: string): string[] => [
  open(index, { type: "thinking", thinking: "" }),
  ...pieces.map((t) => delta(index, { type: "thinking_delta", thinking: t })),
  delta(index, { type: "signature_delta", signature }),
  close(index),
];
