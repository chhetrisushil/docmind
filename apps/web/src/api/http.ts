import { ErrorBody } from "@docmind/contracts";
import type { ZodType } from "zod";

const CODE = /^[a-z][a-z_]{0,39}$/;

/** A failed call. `message` is "<status> <code>" and never the server's own text (it could carry content). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: number | undefined;
  constructor(status: number, code: string, retryAfter?: number) {
    super(`${status} ${code}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** The error for a non-2xx answer: its status, the code from our error body (or "unknown"), and Retry-After in seconds. */
export function apiErrorFrom(
  status: number,
  bodyText: string,
  retryAfter: string | null,
): ApiError {
  let code = "unknown";
  try {
    const parsed = ErrorBody.safeParse(JSON.parse(bodyText));
    if (parsed.success && CODE.test(parsed.data.error.code)) code = parsed.data.error.code;
  } catch {
    // not JSON: "unknown"
  }
  const seconds = retryAfter === null || retryAfter.trim() === "" ? Number.NaN : Number(retryAfter);
  return new ApiError(
    status,
    code,
    Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600 ? seconds : undefined,
  );
}

export interface RequestOptions<T> {
  body?: unknown;
  schema?: ZodType<T>;
  signal?: AbortSignal;
}
export interface Http {
  request<T = undefined>(method: string, path: string, o?: RequestOptions<T>): Promise<T>;
}

export function createHttp(deps: { fetch?: typeof fetch; onUnauthorized?: () => void } = {}): Http {
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return {
    async request<T>(method: string, path: string, o: RequestOptions<T> = {}): Promise<T> {
      const init: RequestInit = {
        method,
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(o.body !== undefined && { "content-type": "application/json" }),
        },
        ...(o.body !== undefined && { body: JSON.stringify(o.body) }),
        ...(o.signal && { signal: o.signal }),
      };
      let res: Response;
      try {
        res = await doFetch(path, init);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err;
        throw new ApiError(0, "network");
      }
      if (!res.ok) {
        const failure = apiErrorFrom(
          res.status,
          await res.text().catch(() => ""),
          res.headers.get("retry-after"),
        );
        if (res.status === 401 && failure.code === "unauthorized") deps.onUnauthorized?.();
        throw failure;
      }
      if (res.status === 204) return undefined as T;
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ApiError(res.status, "bad_response");
      }
      if (!o.schema) return body as T;
      const parsed = o.schema.safeParse(body);
      if (!parsed.success) throw new ApiError(res.status, "bad_response"); // the zod error names fields, never values, but it is not shown either
      return parsed.data;
    },
  };
}
