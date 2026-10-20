import { Locator, Uuid } from "@docmind/contracts";
import type { VectorScope } from "@docmind/vector-pg";
import type { Pool } from "pg";
import { z } from "zod";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { titleBind } from "../../documents/repo";
import { chunkBind } from "../../flows/ingest-document/pgChunks";
import type { LinkKind } from "../../flows/ingest-document/pgLinks";

/** Why a passage was returned: it was reached from `from` by a link (D9). */
export interface Via {
  kind: LinkKind;
  from: string;
  entity?: string;
}

export interface Passage {
  passageId: string;
  documentId: string;
  docTitle: string;
  locator: Locator;
  headingPath: string[];
  text: string;
  via?: Via;
}

export const MAX_READ_IDS = 100;
/** `section`: at most this many chunks and characters, the passage's own chunk first. */
export const SECTION_MAX_CHUNKS = 8;
export const SECTION_MAX_CHARS = 12_000;
/** `neighbours`: this many chunks on each side. */
export const NEIGHBOUR_SPAN = 2;

const isUuid = (s: string) => Uuid.safeParse(s).success;
const SEALED = z.object({ text: z.string(), headingPath: z.array(z.string()) });

interface Row {
  id: string;
  document_id: string;
  ordinal: number;
  locator: unknown;
  text_enc: unknown;
  title_enc: unknown;
}

/**
 * Reads passages across the owner's documents, with text and titles opened (content: never logged).
 * Owner-scoped through the document join inside `withTenant`; scope and ownership are the caller's
 * `VectorScope`. Whether a passage is inside a chat's scope is the caller's to check: `read` returns
 * its `documentId` for that.
 */
export class PassageReader {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  /** The listed chunks that are the owner's, by id. Unknown, foreign and malformed ids are absent. */
  async read(scope: VectorScope, chunkIds: readonly string[]): Promise<Map<string, Passage>> {
    if (chunkIds.length > MAX_READ_IDS)
      throw new RangeError(`read: at most ${MAX_READ_IDS} chunk ids`);
    const ids = [...new Set(chunkIds.map((i) => i.toLowerCase()).filter((i) => isUuid(i)))];
    if (ids.length === 0) return new Map();
    const rows = await withTenant(this.pool, scope.tenantId, async (tx) => {
      const res = await tx.query<Row>(
        `SELECT c.id, c.document_id, c.ordinal, c.locator, c.text_enc, d.title_enc
           FROM chunks c JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
          WHERE d.owner_id = $1 AND c.id = ANY($2::uuid[])`,
        [scope.ownerId, ids],
      );
      return res.rows;
    });
    return new Map((await this.open(scope.ownerId, rows)).map((p) => [p.passageId, p]));
  }

  /**
   * The chunks around `chunkId` in its document, in reading order after the passage itself:
   * `section` is the passage's section, nearest chunks first, at most 8 chunks and 12,000 characters
   * (the passage's own chunk is always kept, cut if it alone is longer); `neighbours` is the two chunks
   * on each side. Another owner's or an unknown chunk yields `[]`.
   */
  async section(
    scope: VectorScope,
    chunkId: string,
    span: "section" | "neighbours",
  ): Promise<Passage[]> {
    if (!isUuid(chunkId)) return [];
    const rows = await withTenant(this.pool, scope.tenantId, async (tx) => {
      const res = await tx.query<Row>(
        `SELECT c.id, c.document_id, c.ordinal, c.locator, c.text_enc, d.title_enc
           FROM chunks t
           JOIN documents d ON d.id = t.document_id AND d.tenant_id = t.tenant_id AND d.owner_id = $1
           JOIN chunks c ON c.tenant_id = t.tenant_id AND c.document_id = t.document_id
            AND (($3 = 'section' AND c.section_ordinal = t.section_ordinal)
              OR ($3 = 'neighbours' AND c.ordinal BETWEEN t.ordinal - $4 AND t.ordinal + $4))
          WHERE t.id = $2::uuid
          ORDER BY abs(c.ordinal - t.ordinal), c.ordinal
          LIMIT $5`,
        [
          scope.ownerId,
          chunkId,
          span,
          NEIGHBOUR_SPAN,
          span === "section" ? SECTION_MAX_CHUNKS : 2 * NEIGHBOUR_SPAN + 1,
        ],
      );
      return res.rows;
    });
    const opened = await this.open(scope.ownerId, rows); // nearest first: the passage itself leads
    const kept: Passage[] = [];
    let chars = 0;
    for (const p of opened) {
      if (span === "section" && kept.length > 0 && chars + p.text.length > SECTION_MAX_CHARS) break;
      kept.push(kept.length === 0 ? { ...p, text: p.text.slice(0, SECTION_MAX_CHARS) } : p);
      chars += p.text.length;
    }
    const ordinal = new Map(rows.map((r) => [r.id, r.ordinal]));
    const [first, ...rest] = kept;
    return first
      ? [
          first,
          ...rest.sort(
            (a, b) => (ordinal.get(a.passageId) as number) - (ordinal.get(b.passageId) as number),
          ),
        ]
      : [];
  }

  private async open(ownerId: string, rows: readonly Row[]): Promise<Passage[]> {
    const cipher = this.fields.forUser(ownerId);
    const titleRows = new Map(rows.map((r) => [r.document_id, r.title_enc]));
    const titles = new Map(
      await Promise.all(
        [...titleRows].map(
          async ([id, enc]) => [id, await cipher.openText(titleBind(id), enc)] as const,
        ),
      ),
    );
    return Promise.all(
      rows.map(async (r) => {
        const sealed = SEALED.safeParse(await cipher.open(chunkBind(r.id), r.text_enc));
        const locator = Locator.safeParse(r.locator);
        // A fixed message: a schema error could carry decrypted content.
        if (!sealed.success || !locator.success)
          throw new Error("the stored chunk has an invalid shape");
        return {
          passageId: r.id,
          documentId: r.document_id,
          docTitle: titles.get(r.document_id) as string,
          locator: locator.data,
          headingPath: sealed.data.headingPath,
          text: sealed.data.text,
        };
      }),
    );
  }
}
