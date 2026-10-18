import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Authenticator, Identity } from "@docmind/auth";
import {
  BlobTooLargeError,
  type EncryptedFsContentStore,
  type StagedBlob,
} from "@docmind/blob-store";
import {
  ListDocumentsQuery,
  type ListDocumentsResponse,
  type UploadDocumentResponse,
  Uuid,
} from "@docmind/contracts";
import type { Pool } from "pg";
import type { FieldCrypto } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import { UploadTooLargeError, receiveFile } from "../http/multipart";
import { peek } from "../http/peek";
import { requireAuth } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";
import { decodeCursor, encodeCursor } from "./cursor";
import { InFlight } from "./inFlight";
import type { IngestPort } from "./ingest";
import type { DocumentLimits } from "./limits";
import {
  filenameBind,
  findByFingerprint,
  getDocument,
  insertDocument,
  listDocuments,
  lockTenantForWrite,
  titleBind,
  toDto,
  usageOfTenant,
} from "./repo";
import { SNIFF_BYTES, type Sniffed, sanitizeFilename, sniff, titleFromFilename } from "./sniff";

export interface DocumentRoutesDeps {
  pool: Pool;
  authenticator: Authenticator;
  fields: FieldCrypto;
  /** A blob store for this user. Cheap to build: no I/O happens until it is used. */
  blobs: (identity: Identity) => EncryptedFsContentStore;
  limits: DocumentLimits;
  /** Starts and cancels document ingestion. */
  ingest: IngestPort;
  /** Uploads in progress per user; defaults to one tracker shared by this process. */
  inFlight?: InFlight;
}

const defaultInFlight = new InFlight();

/** An error answer on the upload route. The request body may be unread, so the connection closes. */
function uploadError(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  res.setHeader("connection", "close");
  sendError(res, status, code, message);
  res.once("finish", () => req.destroy());
}

type Registered =
  | { kind: "stored"; document: UploadDocumentResponse["document"]; duplicate: boolean }
  | { kind: "quota"; reason: "documents" | "storage" };

/** Inserts the row and commits the staged blob, or reports a duplicate. Runs inside one transaction. */
async function register(
  deps: DocumentRoutesDeps,
  identity: Identity,
  store: EncryptedFsContentStore,
  staged: StagedBlob,
  filename: string,
  sniffed: Sniffed,
): Promise<Registered> {
  const id = randomUUID();
  const fingerprint = staged.fingerprint; // keyed HMAC, computed while streaming
  try {
    const cipher = deps.fields.forUser(identity.userId);
    const titleEnc = await cipher.seal(titleBind(id), titleFromFilename(filename));
    const filenameEnc = await cipher.seal(filenameBind(id), filename);
    return await withTenant(deps.pool, identity.tenantId, async (tx) => {
      await lockTenantForWrite(tx, identity.tenantId);
      const existing = await findByFingerprint(tx, identity.userId, fingerprint);
      if (existing) {
        await staged.discard();
        return { kind: "stored", document: await toDto(existing, cipher), duplicate: true };
      }
      const usage = await usageOfTenant(tx);
      if (usage.documents + 1 > deps.limits.tenantMaxDocuments) {
        await staged.discard();
        return { kind: "quota", reason: "documents" };
      }
      if (usage.bytes + (staged.ref.size ?? 0) > deps.limits.tenantMaxBytes) {
        await staged.discard();
        return { kind: "quota", reason: "storage" };
      }
      const row = await insertDocument(tx, {
        id,
        tenantId: identity.tenantId,
        ownerId: identity.userId,
        titleEnc,
        filenameEnc,
        mime: sniffed.mime,
        sizeBytes: staged.ref.size ?? 0,
        contentAddress: staged.ref.__loomContent,
        fingerprint,
      });
      const committed = await staged.commit();
      try {
        return { kind: "stored", document: await toDto(row, cipher), duplicate: false };
      } catch (err) {
        // Still under the tenant lock: take back a blob this upload created, so no concurrent
        // upload of the same bytes can have relied on it. A failure of COMMIT itself happens after
        // this callback returned and keeps the blob (unreferenced blobs are harmless).
        if (committed.created) await store.delete(staged.ref).catch(() => {});
        throw err;
      }
    });
  } catch (err) {
    await staged.discard().catch(() => {}); // a no-op once committed
    throw err;
  }
}

/** Streams the request's file into storage and the database. */
function receive(deps: DocumentRoutesDeps, req: IncomingMessage, identity: Identity) {
  return receiveFile(req, { maxFileBytes: deps.limits.maxFileBytes }, async (file) => {
    const filename = sanitizeFilename(file.filename);
    const { head, rest, close } = await peek(file.body, SNIFF_BYTES);
    try {
      const sniffed = sniff(head, filename);
      if (!sniffed) return { rejected: true as const };
      const store = deps.blobs(identity);
      const staged = await store.stage(rest).catch((err: unknown) => {
        throw err instanceof BlobTooLargeError ? new UploadTooLargeError() : err;
      });
      const result = await register(deps, identity, store, staged, filename, sniffed);
      return { rejected: false as const, result };
    } finally {
      await close(); // idempotent; releases the body if it was never consumed
    }
  });
}

async function upload(
  deps: DocumentRoutesDeps,
  req: IncomingMessage,
  res: ServerResponse,
  identity: Identity,
): Promise<void> {
  const release = (deps.inFlight ?? defaultInFlight).tryAcquire(
    identity.userId,
    deps.limits.maxConcurrentUploadsPerUser,
  );
  if (!release) {
    res.setHeader("retry-after", "5");
    return uploadError(
      req,
      res,
      429,
      "too_many_uploads",
      "too many uploads in progress; try again shortly",
    );
  }
  const outcome = await receive(deps, req, identity).finally(release);

  if (!outcome.ok) return uploadError(req, res, outcome.status, outcome.code, outcome.message);
  if (outcome.value.rejected) {
    return uploadError(req, res, 415, "unsupported_type", "this file type is not supported");
  }
  const result = outcome.value.result;
  if (result.kind === "quota") {
    const message =
      result.reason === "documents" ? "document limit reached" : "storage limit reached";
    return uploadError(req, res, 403, "quota_exceeded", message);
  }
  const { document, duplicate } = result;
  // The row is committed. Only now start the flow: a rolled-back upload must never have an execution.
  // A duplicate whose document never left `uploaded` re-attempts the start, which Loom makes start-once.
  if (!duplicate || document.status === "uploaded") {
    await deps.ingest.start(identity, document.id).catch((err: unknown) => {
      // Class and route only: the message could carry anything.
      console.error(
        "ingest start failed",
        err instanceof Error ? err.constructor.name : typeof err,
        "POST /api/documents",
      );
    });
  }
  json(res, duplicate ? 200 : 201, { document, duplicate } satisfies UploadDocumentResponse);
}

/** The document API. Every route takes the tenant and user from the session, never from the request. */
export function documentRoutes(deps: DocumentRoutesDeps): Record<string, Handler> {
  return {
    "POST /api/documents": requireAuth(deps.authenticator, async (req, res, identity) => {
      try {
        await upload(deps, req, res, identity);
      } catch (err) {
        // Class name and path only: the message could carry a filename, a key id or a ZodError.
        console.error(
          "upload failed",
          err instanceof Error ? err.constructor.name : typeof err,
          "/api/documents",
        );
        if (res.headersSent) return void res.end();
        uploadError(req, res, 500, "internal", "internal error");
      }
    }),

    "GET /api/documents": requireAuth(deps.authenticator, async (req, res, identity) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const query = ListDocumentsQuery.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return sendError(res, 400, "invalid_request", "invalid query");
      let cursor: { t: string; i: string } | null = null;
      if (query.data.cursor !== undefined) {
        cursor = decodeCursor(query.data.cursor);
        if (!cursor) return sendError(res, 400, "invalid_cursor", "cursor is not valid");
      }
      // owner_id comes from the session; the cursor only positions within the caller's own rows.
      const page = await withTenant(deps.pool, identity.tenantId, (tx) =>
        listDocuments(tx, identity.userId, { cursor, limit: query.data.limit }),
      );
      const cipher = deps.fields.forUser(identity.userId);
      json(res, 200, {
        items: await Promise.all(page.rows.map((row) => toDto(row, cipher))),
        nextCursor: page.next ? encodeCursor(page.next) : null,
      } satisfies ListDocumentsResponse);
    }),

    "GET /api/documents/:id": requireAuth(deps.authenticator, async (_req, res, identity, ctx) => {
      const parsed = Uuid.safeParse(ctx.params.id);
      // A malformed id answers exactly like a missing or foreign one.
      const id = parsed.success ? parsed.data.toLowerCase() : null;
      const row = id
        ? await withTenant(deps.pool, identity.tenantId, (tx) =>
            getDocument(tx, identity.userId, id),
          )
        : undefined;
      if (!row) return sendError(res, 404, "not_found", "document not found");
      json(res, 200, await toDto(row, deps.fields.forUser(identity.userId)));
    }),
  };
}
