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
import type { DocumentStatusReads } from "../status/ingestStatus";
import { UPLOADED } from "../status/model";
import { decodeCursor, encodeCursor } from "./cursor";
import { InFlight } from "./inFlight";
import type { IngestPort } from "./ingest";
import type { DocumentLimits } from "./limits";
import {
  deleteDocument,
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
import type { StartScheduler } from "./startScheduler";

export interface DocumentRoutesDeps {
  pool: Pool;
  authenticator: Authenticator;
  fields: FieldCrypto;
  /** A blob store for this user. Cheap to build: no I/O happens until it is used. */
  blobs: (identity: Identity) => EncryptedFsContentStore;
  limits: DocumentLimits;
  /** The ingest-status model: every document status the API answers comes from here. */
  status: DocumentStatusReads;
  /** Starts and cancels document ingestion. */
  ingest: IngestPort;
  /** Test seam: how long a delete waits for a pending start before cancelling anyway. */
  settleTimeoutMs?: number;
  /** Fires flow starts after the upload commits, without making the response wait for them. */
  starts: StartScheduler;
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
  | {
      kind: "stored";
      document: UploadDocumentResponse["document"];
      generation: number;
      duplicate: boolean;
    }
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
        return {
          kind: "stored",
          document: await toDto(existing, cipher, UPLOADED),
          generation: existing.ingest_generation,
          duplicate: true,
        };
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
        return {
          kind: "stored",
          document: await toDto(row, cipher, UPLOADED),
          generation: row.ingest_generation,
          duplicate: false,
        };
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
      // A duplicate is an existing document, so its status is the model's (one log-tail read); a new
      // one is `uploaded`. Resolved before the start decision below, which keys on it.
      if (result.kind === "stored" && result.duplicate) {
        const view = await deps.status.forDocument(identity, result.document.id);
        result.document = { ...result.document, status: view.status, error: view.error };
      }
      // The row is committed (register returns after COMMIT). Fire now, before the body drain and
      // the response, so one round trip (withTenant's reset) separates COMMIT from the registration a
      // delete settles on.
      // A duplicate whose document never left `uploaded` re-attempts the start (Loom: start-once).
      // Not closed: another process's delete cannot see this scheduler; `document_gone` covers that.
      if (
        result.kind === "stored" &&
        (!result.duplicate || result.document.status === "uploaded")
      ) {
        deps.starts.fire(identity, result.document.id, result.generation);
      }
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
  json(res, duplicate ? 200 : 201, { document, duplicate } satisfies UploadDocumentResponse);
}

/** How long a delete waits for that document's pending flow start before it cancels anyway. */
export const SETTLE_TIMEOUT_MS = 5000;

async function settleWithin(
  starts: StartScheduler,
  identity: Identity,
  documentId: string,
  ms: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([starts.settle(identity, documentId), timeout]);
  } finally {
    clearTimeout(timer);
  }
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
      const views = await deps.status.forPage(
        identity,
        page.rows.map((row) => row.id),
      );
      json(res, 200, {
        items: await Promise.all(
          page.rows.map((row) => toDto(row, cipher, views.get(row.id) ?? UPLOADED)),
        ),
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
      const view = await deps.status.forDocument(identity, row.id);
      json(res, 200, await toDto(row, deps.fields.forUser(identity.userId), view));
    }),

    "DELETE /api/documents/:id": requireAuth(
      deps.authenticator,
      async (_req, res, identity, ctx) => {
        const parsed = Uuid.safeParse(ctx.params.id);
        const id = parsed.success ? parsed.data.toLowerCase() : null;
        const mine = id
          ? await withTenant(deps.pool, identity.tenantId, (tx) =>
              getDocument(tx, identity.userId, id),
            )
          : undefined;
        if (!mine) return sendError(res, 404, "not_found", "document not found");

        // 1. Cancel the ingest execution first, outside any transaction. If this throws nothing has
        //    been deleted and the delete can be repeated; a step still running when the cancel lands
        //    finds its document gone and stops cleanly.
        //    A start still in flight for this document lands first, so the cancel finds it.
        //    The wait is bounded: past it the cancel goes ahead and `document_gone` covers a late start.
        await settleWithin(
          deps.starts,
          identity,
          mine.id,
          deps.settleTimeoutMs ?? SETTLE_TIMEOUT_MS,
        );
        await deps.ingest.cancel(identity, mine.id, mine.ingest_generation);

        // 2. Row and blob go under the tenant lock that uploads take before reusing a blob, so an
        //    upload of the same bytes cannot slip between the two (the store's contract). If COMMIT
        //    fails the row survives without its blob; deleting again finishes the job.
        const store = deps.blobs(identity);
        const removed = await withTenant(deps.pool, identity.tenantId, async (tx) => {
          await lockTenantForWrite(tx, identity.tenantId);
          const current = await getDocument(tx, identity.userId, mine.id);
          if (!current) return false; // a concurrent delete won
          const gone = await deleteDocument(tx, identity.userId, current.id);
          if (!gone) return false;
          await store.delete({ __loomContent: gone.contentAddress });
          return true;
        });
        if (!removed) return sendError(res, 404, "not_found", "document not found");

        // 3. The row and blob are gone (committed) and the flow is cancelled: now forget the status
        //    rows. A failure here must not turn a completed delete into an error: log the class only
        //    and answer 204; M5's forgetUser tombstones whatever is left.
        try {
          await deps.status.forgetDocument(identity, mine.id);
        } catch (err) {
          console.error(
            "forget document status failed",
            err instanceof Error ? err.constructor.name : typeof err,
            "DELETE /api/documents/:id",
          );
        }
        res.writeHead(204);
        res.end();
      },
    ),
  };
}
