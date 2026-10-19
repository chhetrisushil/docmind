// Messages are fixed: a provider error can carry a prompt, a document or the key.
const withStatus = (base: string, status?: number) =>
  status === undefined ? base : `${base} (HTTP ${status})`;

/** Transient: a network failure, a timeout, 408, 409, 429, 5xx or 529. Retried by the caller's policy. */
export class LlmUnavailableError extends Error {
  constructor(readonly status?: number) {
    super(withStatus("the language model is unavailable", status));
    this.name = "LlmUnavailableError";
  }
}

/** Permanent: any other 4xx, an unsupported part, an oversized or malformed response. */
export class LlmRequestError extends Error {
  constructor(readonly status?: number) {
    super(withStatus("the language model rejected the request", status));
    this.name = "LlmRequestError";
  }
}

/** The model declined (`stop_reason: "refusal"`). */
export class LlmRefusalError extends Error {
  constructor() {
    super("the language model declined the request");
    this.name = "LlmRefusalError";
  }
}

export class LlmAbortedError extends Error {
  constructor() {
    super("the language model call was aborted");
    this.name = "LlmAbortedError";
  }
}

/** A caller's schema check of the model's output failed. Transient: a second sample usually conforms. */
export class LlmOutputError extends Error {
  constructor() {
    super("the language model returned output of the wrong shape");
    this.name = "LlmOutputError";
  }
}
