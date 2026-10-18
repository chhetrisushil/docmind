import {
  type DocumentDto,
  DocumentStats,
  type DocumentStatus,
  DocumentSummary,
} from "@docmind/contracts";
import type { PoolClient } from "pg";
import type { UserFieldCipher } from "../crypto/fields";

export const titleBind = (id: string) => `document:${id}:title`;
export const filenameBind = (id: string) => `document:${id}:filename`;
export const statsBind = (id: string) => `document:${id}:stats`;
export const summaryBind = (id: string) => `document:${id}:summary`;

/** The SELECT/RETURNING list. `created_cursor` is the microsecond-exact keyset value. */
export const DOCUMENT_COLUMNS = `id, title_enc, filename_enc, mime, size_bytes, status, error, stats_enc,
  summary_enc, created_at, updated_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_cursor`;

export interface DocumentRow {
  id: string;
  title_enc: unknown;
  filename_enc: unknown;
  mime: string;
  size_bytes: string; // bigint arrives as text
  status: DocumentStatus;
  error: string | null;
  stats_enc: unknown;
  summary_enc: unknown;
  created_at: Date;
  updated_at: Date;
  created_cursor: string;
}

export interface NewDocument {
  id: string;
  tenantId: string;
  ownerId: string;
  titleEnc: unknown;
  filenameEnc: unknown;
  mime: string;
  sizeBytes: number;
  contentAddress: string;
  fingerprint: string;
}

export async function findByFingerprint(
  tx: PoolClient,
  ownerId: string,
  fingerprint: string,
): Promise<DocumentRow | undefined> {
  const { rows } = await tx.query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE owner_id = $1 AND fingerprint = $2`,
    [ownerId, fingerprint],
  );
  return rows[0];
}

export async function insertDocument(tx: PoolClient, doc: NewDocument): Promise<DocumentRow> {
  const { rows } = await tx.query<DocumentRow>(
    `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes,
                            content_address, fingerprint)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
     RETURNING ${DOCUMENT_COLUMNS}`,
    [
      doc.id,
      doc.tenantId,
      doc.ownerId,
      JSON.stringify(doc.titleEnc),
      JSON.stringify(doc.filenameEnc),
      doc.mime,
      doc.sizeBytes,
      doc.contentAddress,
      doc.fingerprint,
    ],
  );
  return rows[0] as DocumentRow;
}

export async function toDto(row: DocumentRow, cipher: UserFieldCipher): Promise<DocumentDto> {
  return {
    id: row.id,
    title: await cipher.openText(titleBind(row.id), row.title_enc),
    filename: await cipher.openText(filenameBind(row.id), row.filename_enc),
    mime: row.mime,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    error: row.error,
    stats:
      row.stats_enc == null
        ? null
        : DocumentStats.parse(await cipher.open(statsBind(row.id), row.stats_enc)),
    summary:
      row.summary_enc == null
        ? null
        : DocumentSummary.parse(await cipher.open(summaryBind(row.id), row.summary_enc)),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Serialises writers of one tenant until the transaction ends: quota checks, the duplicate check
 * and the delete's blob removal all run under it, so they cannot interleave. Held for the length
 * of a transaction only (the file itself is staged before it is taken). Call it inside the
 * `withTenant` transaction for the same tenant, before any read the decision depends on; outside a
 * transaction it silently does nothing.
 */
export async function lockTenantForWrite(tx: PoolClient, tenantId: string): Promise<void> {
  await tx.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [
    `docmind:documents:${tenantId}`,
  ]);
}

/** Documents and bytes held by the transaction's tenant (row-level security does the scoping). */
export async function usageOfTenant(tx: PoolClient): Promise<{ documents: number; bytes: number }> {
  const { rows } = await tx.query<{ documents: number; bytes: string }>(
    "SELECT count(*)::int AS documents, coalesce(sum(size_bytes), 0)::text AS bytes FROM documents",
  );
  const row = rows[0] as { documents: number; bytes: string };
  return { documents: row.documents, bytes: Number(row.bytes) };
}

export async function listDocuments(
  tx: PoolClient,
  ownerId: string,
  page: { cursor: { t: string; i: string } | null; limit: number },
): Promise<{ rows: DocumentRow[]; next: { created_cursor: string; id: string } | null }> {
  const { rows } = await tx.query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents
      WHERE owner_id = $1
        AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT $4`,
    [ownerId, page.cursor?.t ?? null, page.cursor?.i ?? null, page.limit + 1],
  );
  const more = rows.length > page.limit;
  const kept = more ? rows.slice(0, page.limit) : rows;
  const last = kept[kept.length - 1];
  return {
    rows: kept,
    next: more && last ? { created_cursor: last.created_cursor, id: last.id } : null,
  };
}
