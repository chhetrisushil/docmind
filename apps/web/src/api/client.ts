import {
  ChatSessionDto,
  type CreateChatRequest,
  type DeleteAccountRequest,
  DeleteAccountResponse,
  type DocumentDto,
  ErasureStatusResponse,
  ListMessagesResponse,
  type LoginRequest,
  MeResponse,
  type PatchChatRequest,
  RetryDocumentResponse,
  type SendMessageRequest,
  SendMessageResponse,
  type SignUpRequest,
  SignUpResponse,
  StopChatResponse,
  UploadDocumentResponse,
} from "@docmind/contracts";
import { ApiError, type Http, apiErrorFrom } from "./http";

const qs = (o: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
const seg = encodeURIComponent;

export interface Api {
  signUp(req: SignUpRequest): Promise<void>;
  login(req: LoginRequest): Promise<MeResponse>;
  logout(): Promise<void>;
  me(): Promise<MeResponse>;
  deleteAccount(req: DeleteAccountRequest): Promise<DeleteAccountResponse>;
  erasureStatus(receipt: string): Promise<ErasureStatusResponse>;
  deleteDocument(id: string): Promise<void>;
  retryDocument(id: string): Promise<DocumentDto>;
  uploadDocument(
    file: File,
    o?: { onProgress?(percent: number): void; signal?: AbortSignal },
  ): Promise<UploadDocumentResponse>;
  createChat(req: CreateChatRequest): Promise<ChatSessionDto>;
  getChat(id: string): Promise<ChatSessionDto>;
  patchChat(id: string, req: PatchChatRequest): Promise<ChatSessionDto>;
  deleteChat(id: string): Promise<void>;
  listMessages(id: string, cursor?: string): Promise<ListMessagesResponse>;
  sendMessage(id: string, req: SendMessageRequest): Promise<SendMessageResponse>;
  stopChat(id: string): Promise<StopChatResponse>;
}

export function createApi(
  http: Http,
  opts: { xhr?: () => XMLHttpRequest; onUnauthorized?: () => void } = {},
): Api {
  const newXhr = opts.xhr ?? (() => new XMLHttpRequest());
  return {
    signUp: async (req) =>
      void (await http.request("POST", "/api/auth/sign-up", { body: req, schema: SignUpResponse })),
    login: (req) => http.request("POST", "/api/auth/login", { body: req, schema: MeResponse }),
    logout: () => http.request("POST", "/api/auth/logout"),
    me: () => http.request("GET", "/api/me", { schema: MeResponse }),
    deleteAccount: (req) =>
      http.request("DELETE", "/api/me", { body: req, schema: DeleteAccountResponse }),
    erasureStatus: (receipt) =>
      http.request("GET", `/api/erasure/${seg(receipt)}`, { schema: ErasureStatusResponse }),
    deleteDocument: (id) => http.request("DELETE", `/api/documents/${seg(id)}`),
    retryDocument: async (id) =>
      (
        await http.request("POST", `/api/documents/${seg(id)}/retry`, {
          schema: RetryDocumentResponse,
        })
      ).document,
    uploadDocument: (file, o = {}) =>
      new Promise((resolve, reject) => {
        const xhr = newXhr();
        xhr.open("POST", "/api/documents");
        xhr.withCredentials = true;
        xhr.responseType = "text";
        xhr.setRequestHeader("accept", "application/json");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable && e.total > 0)
            o.onProgress?.(Math.min(100, Math.floor((e.loaded * 100) / e.total)));
        };
        const lost = () => reject(new ApiError(0, "network"));
        xhr.onerror = lost;
        xhr.ontimeout = lost;
        xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const parsed = UploadDocumentResponse.safeParse(JSON.parse(xhr.responseText));
              if (parsed.success) return resolve(parsed.data);
            } catch {
              // fall through
            }
            return reject(new ApiError(xhr.status, "bad_response"));
          }
          const failure = apiErrorFrom(
            xhr.status,
            xhr.responseText,
            xhr.getResponseHeader("retry-after"),
          );
          if (xhr.status === 401 && failure.code === "unauthorized") opts.onUnauthorized?.();
          reject(failure);
        };
        o.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
        const form = new FormData();
        form.append("file", file, file.name);
        xhr.send(form);
      }),
    createChat: (req) => http.request("POST", "/api/chats", { body: req, schema: ChatSessionDto }),
    getChat: (id) => http.request("GET", `/api/chats/${seg(id)}`, { schema: ChatSessionDto }),
    patchChat: (id, req) =>
      http.request("PATCH", `/api/chats/${seg(id)}`, { body: req, schema: ChatSessionDto }),
    deleteChat: (id) => http.request("DELETE", `/api/chats/${seg(id)}`),
    listMessages: (id, cursor) =>
      http.request("GET", `/api/chats/${seg(id)}/messages${qs({ cursor })}`, {
        schema: ListMessagesResponse,
      }),
    sendMessage: (id, req) =>
      http.request("POST", `/api/chats/${seg(id)}/messages`, {
        body: req,
        schema: SendMessageResponse,
      }),
    stopChat: (id) =>
      http.request("POST", `/api/chats/${seg(id)}/stop`, { schema: StopChatResponse }),
  };
}
