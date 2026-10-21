import { type DocumentDto, DocumentProgressEvent } from "@docmind/contracts";
import type { Api } from "../api/client";
import { ApiError } from "../api/http";
import type { OpenSse, SseCloseReason } from "../api/sse";
import type { AuthStore } from "./auth";
import { Store } from "./store";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const UPLOAD_CONCURRENCY = 2;
export const UPLOAD_EXTENSIONS = [
  "txt",
  "md",
  "org",
  "doc",
  "docx",
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
] as const;

export type UploadReason =
  | "too_large"
  | "unsupported"
  | "quota"
  | "network"
  | "server"
  | "cancelled";
export interface UploadItem {
  key: string;
  name: string;
  size: number;
  percent: number;
  state: "queued" | "uploading" | "failed";
  reason?: UploadReason;
}
export interface UploadResult {
  file: File;
  document?: DocumentDto;
  duplicate?: boolean;
  reason?: UploadReason;
}

const reasonOf = (err: unknown): UploadReason => {
  if (err instanceof ApiError) {
    if (err.status === 403 && err.code === "quota_exceeded") return "quota";
    if (err.status === 413) return "too_large";
    if (err.status === 415) return "unsupported";
    if (err.status === 0) return "network";
  }
  return "server";
};
const extensionOf = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();

/**
 * The browser's upload queue and the document progress stream. Which documents exist is the library view's business, not
 * this store's. These checks are UX only: the server checks size, type and quota again. Given `auth`, signing out cancels
 * every upload, empties the queue (names must not outlive the session) and closes the stream.
 */
export class UploadsStore extends Store<{ uploads: UploadItem[] }> {
  private events: { close(): void } | undefined;
  private opens = 0;
  private seq = 0;
  private readonly controllers = new Map<string, AbortController>();
  constructor(
    private readonly api: Pick<Api, "uploadDocument">,
    private readonly open: OpenSse,
    private readonly auth?: Pick<AuthStore, "epoch" | "expired" | "subscribe" | "get">,
  ) {
    super({ uploads: [] });
    auth?.subscribe((s) => {
      if (s.status === "signed-in") return;
      this.cancelAll();
      this.stopEvents();
      this.set({ uploads: [] });
    });
  }

  dismissUpload(key: string): void {
    this.update((s) => ({ uploads: s.uploads.filter((u) => u.key !== key) }));
  }
  /** Aborts a running upload's request, or keeps a waiting one from ever being sent. The item goes away; it did not fail. */
  cancel(key: string): void {
    this.controllers.get(key)?.abort();
  }
  cancelAll(): void {
    for (const c of this.controllers.values()) c.abort();
  }
  private patch(key: string, patch: Partial<UploadItem>): void {
    this.update((s) => ({
      uploads: s.uploads.map((u) => (u.key === key ? { ...u, ...patch } : u)),
    }));
  }

  /** Never rejects. One result per file, in the order given. */
  async upload(files: File[]): Promise<UploadResult[]> {
    const results: UploadResult[] = files.map((file) => ({ file }));
    const queue: { file: File; key: string; at: number; ctl: AbortController }[] = [];
    files.forEach((file, at) => {
      const key = `u${++this.seq}`;
      const reason: UploadReason | undefined =
        file.size > MAX_UPLOAD_BYTES
          ? "too_large"
          : (UPLOAD_EXTENSIONS as readonly string[]).includes(extensionOf(file.name))
            ? undefined
            : "unsupported";
      this.update((s) => ({
        uploads: [
          ...s.uploads,
          {
            key,
            name: file.name,
            size: file.size,
            percent: 0,
            state: reason ? "failed" : "queued",
            ...(reason && { reason }),
          },
        ],
      }));
      if (reason) (results[at] as UploadResult).reason = reason;
      else {
        const ctl = new AbortController();
        this.controllers.set(key, ctl);
        queue.push({ file, key, at, ctl });
      }
    });
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { file, key, at, ctl } = next;
        try {
          if (ctl.signal.aborted) throw new DOMException("aborted", "AbortError");
          this.patch(key, { state: "uploading" });
          const out = await this.api.uploadDocument(file, {
            signal: ctl.signal,
            onProgress: (percent) => this.patch(key, { percent }),
          });
          this.dismissUpload(key);
          results[at] = { file, document: out.document, duplicate: out.duplicate };
        } catch (err) {
          if (ctl.signal.aborted) {
            this.dismissUpload(key);
            results[at] = { file, reason: "cancelled" };
          } else {
            const reason = reasonOf(err);
            this.patch(key, { state: "failed", reason, percent: 0 });
            results[at] = { file, reason };
          }
        } finally {
          this.controllers.delete(key);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, worker));
    return results;
  }

  /**
   * Opens the document progress stream. `onEnd` hears why it ended for good (carrying no content), after which it may be
   * started again. A 401 ends the session the stream was opened in, and no other.
   */
  startEvents(
    onProgress: (e: DocumentProgressEvent | "resync") => void,
    onEnd?: (reason: SseCloseReason) => void,
  ): void {
    if (this.events) return;
    const epoch = this.auth?.epoch;
    this.events = this.open({
      url: "/api/documents/events",
      onOpen: () => {
        if (++this.opens > 1) onProgress("resync");
      },
      onFrame: (frame) => {
        if (frame.event !== "progress") return;
        try {
          const parsed = DocumentProgressEvent.safeParse(JSON.parse(frame.data));
          if (parsed.success) onProgress(parsed.data);
        } catch {
          // a frame that is not JSON is dropped
        }
      },
      onClose: (reason) => {
        this.events = undefined;
        this.opens = 0;
        if (reason === "unauthorized") this.auth?.expired(epoch);
        onEnd?.(reason);
      },
    });
  }
  stopEvents(): void {
    const events = this.events;
    this.events = undefined;
    this.opens = 0;
    events?.close();
  }
}
