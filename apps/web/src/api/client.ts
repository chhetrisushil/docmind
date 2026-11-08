import {
  ChatSessionDto,
  type CreateChatRequest,
  type DeleteAccountRequest,
  DeleteAccountResponse,
  DocumentDto,
  ErasureStatusResponse,
  ListDocumentsResponse,
  ListMessagesResponse,
  type LoginRequest,
  MeResponse,
  type PatchChatRequest,
  RetryDocumentResponse,
  RetryVisualsResponse,
  type SendMessageRequest,
  SendMessageResponse,
  type SignUpRequest,
  SignUpResponse,
  StopChatResponse,
  UiHydrateResponse,
  UiViewResponse,
  UploadDocumentResponse,
  type ViewName,
  VisualizeTurnResponse,
} from "@docmind/contracts";
import type { HandleLoadRequest } from "@loom-ui/hydration/client";
import { ApiError, type Http, apiErrorFrom } from "./http";

const qs = (o: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
const seg = encodeURIComponent;

/** What a view session hydrates against: a named view, one document's detail experience, or one chat turn's visuals. */
export type ViewSource =
  | { view: ViewName }
  | { document: string }
  | { turn: { chatId: string; ord: number } };

export interface Api {
  signUp(req: SignUpRequest): Promise<void>;
  login(req: LoginRequest): Promise<MeResponse>;
  logout(): Promise<void>;
  me(): Promise<MeResponse>;
  deleteAccount(req: DeleteAccountRequest): Promise<DeleteAccountResponse>;
  erasureStatus(receipt: string): Promise<ErasureStatusResponse>;
  deleteDocument(id: string): Promise<void>;
  retryDocument(id: string): Promise<DocumentDto>;
  listDocuments(cursor?: string): Promise<ListDocumentsResponse>;
  getDocument(id: string): Promise<DocumentDto>;
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
  uiView(name: ViewName, signal?: AbortSignal): Promise<UiViewResponse>;
  /** The per-document detail: the static detail plus this document's visuals. */
  uiDocumentDetail(id: string, signal?: AbortSignal): Promise<UiViewResponse>;
  /** A chat turn's compiled visuals (404 when it has none). */
  uiTurnVisuals(chatId: string, ord: number, signal?: AbortSignal): Promise<UiViewResponse>;
  /** Asks for the document's visuals to be made again (202). Rejects with `ApiError`: 409 `visualize_running` / `not_visualizable`, 429. */
  retryDocumentVisuals(id: string): Promise<void>;
  /** Asks for the turn's visuals to be made (202). Rejects with `ApiError`: 409 `visualize_running` / `not_visualizable`, 429. */
  visualizeTurn(chatId: string, ord: number): Promise<void>;
  uiHydrate(
    source: ViewSource,
    requests: HandleLoadRequest[],
    signal?: AbortSignal,
  ): Promise<unknown[]>;
}

export function createApi(
  http: Http,
  opts: {
    xhr?: () => XMLHttpRequest;
    epoch?: () => number;
    onUnauthorized?: (epoch: number | undefined) => void;
  } = {},
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
    listDocuments: (cursor) =>
      http.request("GET", `/api/documents${qs({ cursor, limit: 100 })}`, {
        schema: ListDocumentsResponse,
      }),
    getDocument: (id) => http.request("GET", `/api/documents/${seg(id)}`, { schema: DocumentDto }),
    uploadDocument: (file, o = {}) =>
      new Promise((resolve, reject) => {
        if (o.signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
        const sentIn = opts.epoch?.();
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
          if (xhr.status === 401 && failure.code === "unauthorized") opts.onUnauthorized?.(sentIn);
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
    uiView: (name, signal) =>
      http.request("GET", `/api/ui/views/${seg(name)}?surface=web`, {
        schema: UiViewResponse,
        ...(signal && { signal }),
      }),
    uiDocumentDetail: (id, signal) =>
      http.request("GET", `/api/ui/documents/${seg(id)}/detail?surface=web`, {
        schema: UiViewResponse,
        ...(signal && { signal }),
      }),
    uiTurnVisuals: (chatId, ord, signal) =>
      http.request("GET", `/api/ui/chats/${seg(chatId)}/turns/${ord}/visuals?surface=web`, {
        schema: UiViewResponse,
        ...(signal && { signal }),
      }),
    retryDocumentVisuals: async (id) => {
      await http.request("POST", `/api/documents/${seg(id)}/visuals/retry`, {
        schema: RetryVisualsResponse,
      });
    },
    visualizeTurn: async (chatId, ord) => {
      await http.request("POST", `/api/chats/${seg(chatId)}/turns/${ord}/visualize`, {
        schema: VisualizeTurnResponse,
      });
    },
    uiHydrate: async (source, requests, signal) =>
      (
        await http.request("POST", "/api/ui/hydrate", {
          body: { ...source, requests },
          schema: UiHydrateResponse,
          ...(signal && { signal }),
        })
      ).results,
  };
}
