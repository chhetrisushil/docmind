import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Authenticator, Identity } from "@docmind/auth";
import {
  BlobTooLargeError,
  type EncryptedFsContentStore,
  type StagedBlob,
} from "@docmind/blob-store";
import type { UploadDocumentResponse } from "@docmind/contracts";
import type { Pool } from "pg";
import type { FieldCrypto } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import { UploadTooLargeError, receiveFile } from "../http/multipart";
import { peek } from "../http/peek";
import { requireAuth } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";
import type { DocumentLimits } from "./limits";
import {
  filenameBind,
  findByFingerprint,
  insertDocument,
  lockTenantForWrite,
  titleBind,
  toDto,
} from "./repo";
import { SNIFF_BYTES, type Sniffed, sanitizeFilename, sniff, titleFromFilename } from "./sniff";

export interface DocumentRoutesDeps {
  pool: Pool;
  authenticator: Authenticator;
  fields: FieldCrypto;
  /** A blob store for this user. Cheap to build: no I/O happens until it is used. */
  blobs: (identity: Identity) => EncryptedFsContentStore;
  limits: DocumentLimits;
}

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

type Registered = { document: UploadDocumentResponse["document"]; duplicate: boolean };

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
        return { document: await toDto(existing, cipher), duplicate: true };
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
        return { document: await toDto(row, cipher), duplicate: false };
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

async function upload(
  deps: DocumentRoutesDeps,
  req: IncomingMessage,
  res: ServerResponse,
  identity: Identity,
): Promise<void> {
  const outcome = await receiveFile(
    req,
    { maxFileBytes: deps.limits.maxFileBytes },
    async (file) => {
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
    },
  );

  if (!outcome.ok) return uploadError(req, res, outcome.status, outcome.code, outcome.message);
  if (outcome.value.rejected) {
    return uploadError(req, res, 415, "unsupported_type", "this file type is not supported");
  }
  const { document, duplicate } = outcome.value.result;
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
  };
}
