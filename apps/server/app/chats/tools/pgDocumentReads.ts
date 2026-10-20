import { DocumentStats, DocumentSummary } from "@docmind/contracts";
import type { VectorScope } from "@docmind/vector-pg";
import type { Pool } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import {
  getDocument,
  listDocuments,
  statsBind,
  summaryBind,
  titleBind,
} from "../../documents/repo";
import type { DocumentStatusReads } from "../../status/ingestStatus";
import { UPLOADED } from "../../status/model";
import type { DocumentReads, DocumentSummaryView, ListedDocument } from "./documents";

const PAGE = 100;
/** The title filter runs after decryption, so it reads at most this many of the owner's documents. */
const SCAN_CAP = 2_000;

export class PgDocumentReads implements DocumentReads {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
    private readonly status: Pick<DocumentStatusReads, "forPage">,
  ) {}

  async summary(scope: VectorScope, documentId: string): Promise<DocumentSummaryView | null> {
    const row = await withTenant(this.pool, scope.tenantId, (tx) =>
      getDocument(tx, scope.ownerId, documentId),
    );
    if (!row) return null;
    const cipher = this.fields.forUser(scope.ownerId);
    return {
      title: await cipher.openText(titleBind(row.id), row.title_enc),
      summary:
        row.summary_enc == null
          ? null
          : DocumentSummary.parse(await cipher.open(summaryBind(row.id), row.summary_enc)),
      stats:
        row.stats_enc == null
          ? null
          : DocumentStats.parse(await cipher.open(statsBind(row.id), row.stats_enc)),
    };
  }

  async list(
    scope: VectorScope,
    filter: { titleContains?: string; documentIds?: readonly string[]; limit: number },
  ): Promise<ListedDocument[]> {
    const cipher = this.fields.forUser(scope.ownerId);
    const needle = filter.titleContains?.toLowerCase();
    const allowed = filter.documentIds ? new Set(filter.documentIds) : undefined;
    const found: {
      id: string;
      generation: number;
      title: string;
      mime: string;
      createdAt: string;
    }[] = [];
    let cursor: { t: string; i: string } | null = null;
    let scanned = 0;
    while (found.length < filter.limit && scanned < SCAN_CAP) {
      const at: { t: string; i: string } | null = cursor;
      const page: Awaited<ReturnType<typeof listDocuments>> = await withTenant(
        this.pool,
        scope.tenantId,
        (tx) => listDocuments(tx, scope.ownerId, { cursor: at, limit: PAGE }),
      );
      for (const row of page.rows) {
        scanned++;
        if (allowed && !allowed.has(row.id)) continue;
        const title = await cipher.openText(titleBind(row.id), row.title_enc);
        if (needle && !title.toLowerCase().includes(needle)) continue;
        found.push({
          id: row.id,
          generation: row.ingest_generation,
          title,
          mime: row.mime,
          createdAt: row.created_at.toISOString(),
        });
        if (found.length >= filter.limit) break;
      }
      if (!page.next) break;
      cursor = { t: page.next.created_cursor, i: page.next.id };
    }
    const views = await this.status.forPage(
      { tenantId: scope.tenantId, userId: scope.ownerId } as Parameters<
        DocumentStatusReads["forPage"]
      >[0],
      found.map((d) => ({ id: d.id, generation: d.generation })),
    );
    return found.map((d) => ({
      documentId: d.id,
      title: d.title,
      mime: d.mime,
      status: (views.get(d.id) ?? UPLOADED).status,
      createdAt: d.createdAt,
    }));
  }
}
