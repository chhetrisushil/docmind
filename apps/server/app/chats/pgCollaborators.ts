import type { ChunkVectorStore } from "@docmind/vector-pg";
import type { EmbeddingProvider } from "@loom/memory";
import type { Pool } from "pg";
import type { FieldCrypto } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import type { DocumentStatusReads } from "../status/ingestStatus";
import { LinkReader, PassageReader, Retriever } from "./retrieval";
import { getChat } from "./sessions";
import { PgDocumentReads } from "./tools/pgDocumentReads";
import { PgReasoningBlocks, PgTurnItems } from "./turnItems";
import { type ChatCollaborators, logHopError } from "./wiring";

export function pgCollaborators(o: {
  pool: Pool;
  fields: FieldCrypto;
  vectors: ChunkVectorStore;
  embedder: EmbeddingProvider;
  hops: 0 | 1 | 2;
  status: Pick<DocumentStatusReads, "forPage">;
}): ChatCollaborators {
  const passages = new PassageReader(o.pool, o.fields);
  return {
    items: new PgTurnItems(o.pool, o.fields),
    blocks: new PgReasoningBlocks(o.pool, o.fields),
    passages,
    retriever: new Retriever({
      embedder: o.embedder,
      vectors: o.vectors,
      passages,
      links: new LinkReader(o.pool, o.fields),
      hops: o.hops,
      onHopError: logHopError,
    }),
    // The chat's scope, read from its row at every tool call; a deleted or foreign chat is null.
    chats: {
      scopeOf: async (ref) =>
        (await withTenant(o.pool, ref.tenantId, (tx) => getChat(tx, ref.userId, ref.chatId)))
          ?.scope ?? null,
    },
    documents: new PgDocumentReads(o.pool, o.fields, o.status),
  };
}
