# Linked retrieval: semantic seeds, then link hops

**Status:** proposal (2026-10-18). Targets M3 (ingestion) and M4 (chat). Amends spec §4.2, §5 and §6.2
once accepted.

## Problem

v1 retrieval is one shot: embed the question, take the pgvector top-k, re-rank with MMR (spec §6.2).
That finds passages that *sound like* the question. It misses passages that are *related* to them but
phrased differently:

- "What changed between v1 and v2 of the policy?" needs both versions; only one is close to the query.
- "Who approved the vendor in the Q3 contract?" may live in an email that never says "Q3 contract".
- An answer in one section often depends on a definition in another section or another document.

## Idea

Borrow the *concept* from linked knowledge formats (e.g. OKF), not the format: at ingestion, record
explicit links between chunks; at question time, use semantic search to find **seeds**, then follow
links one or two **hops** to pull in related passages the embedding alone would miss.

```
question ──embed──► top-k seeds (pgvector + MMR)
                        │
                        ├─ hop 1: follow links from each seed (weighted, capped)
                        ├─ hop 2: optional, only from strong hop-1 nodes
                        ▼
              merge + re-score + budget (k ≤ 12) ──► agent, with citations as today
```

## Links

Links are between **chunks** (passages), so citations keep working unchanged. Each link has a kind
and a weight in `[0, 1]`.

| Kind | How it's found | Cost | Example |
|---|---|---|---|
| `structure` | Same document: neighbouring chunk, same section, heading → body | Free (from the chunker) | A clause and its definition two chunks later |
| `reference` | A chunk names another document (title, filename, "see …", URL) matched against the user's documents | Cheap (string match, LLM fallback) | "as set out in the Master Services Agreement" |
| `entity` | Two chunks mention the same entity (person, organisation, product, project) | Medium (reuses the summarize step's per-section `entities[]`) | Both mention "Acme Ltd" |
| `similar` | Cross-document nearest neighbours above a threshold, computed once at ingestion | Cheap (pgvector) | Two versions of the same policy section |

`structure` already exists implicitly in `read_section`; it becomes a link so hops can use it.

## Storage

All per tenant, under RLS, and erased with the user like `chunks`:

- `chunk_links (tenant_id, src_chunk_id, dst_chunk_id, kind, weight, created_at)`, with both
  endpoints `→ chunks ON DELETE CASCADE`, so deleting a document removes its links. Stored in both
  directions for cheap lookup. A per-chunk cap of `max_degree` (e.g. 24) is kept by weight, so hubs
  can't explode.
- `entities (tenant_id, id, kind, name_enc, name_key)` and `chunk_entities (tenant_id, chunk_id,
  entity_id)`. `name_enc` is AEAD under the user's DEK, like other `*_enc` columns. `name_key` is an
  HMAC of the normalised name, keyed from the user's DEK, so "Acme Ltd" can be matched across
  documents without storing it in plaintext. Once the key is destroyed, the HMACs can't be tested
  against guesses.

**Privacy note.** Link *existence* (which chunk relates to which) is plaintext metadata, in the same
class as `chunks.embedding`. It is hard-deleted on erasure and survives only in backups for their
retention window. That's documented as a known trade-off, alongside embeddings.

## Ingestion (M3)

A new `link` step runs after `embed` and `summarize` in the `ingest-document` flow. It's idempotent
per document, like the other steps:

1. `structure` links from the chunker's section tree.
2. `similar`: for each new chunk, take the pgvector top-m (e.g. 5) from the user's *other* documents,
   above a similarity threshold. Insert both directions, so older documents gain links to the new one.
3. `entity`: the summarize map step already runs per section; extend its JSON to return the entities
   per section, attach them to that section's chunks, and resolve them through `name_key`.
4. `reference`: match chunk text against the user's document titles and filenames. Use the LLM only
   for ambiguous mentions, through `guardRequest` as untrusted input.

Re-embedding or re-ingesting a document deletes its links and rebuilds them.

## Retrieval (M4)

`search_docs(query, k ≤ 12, hops = 1)`:

1. **Seeds.** As today: embed, pgvector top-`k_seed` (e.g. 8), MMR.
2. **Expand.** Follow each seed's links one hop and take the top-`fanout` (e.g. 4) by weight. With
   `hops = 2`, also expand hop-1 nodes whose score clears a floor.
3. **Score.** `score(node) = max over paths(seed_sim × Π edge_weight × decay^depth)`, blended with the
   node's own similarity to the query, since we have its embedding anyway. That keeps a strongly linked
   but off-topic passage from crowding out a relevant one.
4. **Budget.** Merge, dedupe, keep the top `k`, apply MMR again, and return the hop path with each
   passage (e.g. `via: entity "Acme Ltd"`), so the agent and the UI can explain why it was included.

The agent also gets a tool, `related(passageId, kinds?)`, to hop deliberately from a passage it found
promising. This keeps automatic expansion shallow (1 hop) while still allowing deeper chains. Hops
return retrieved passages, so `checkCitations` and source cards work unchanged.

## Evaluation

Extend the retrieval eval (spec §7, `loom eval`) with a multi-hop fixture set: questions whose answer
needs two documents. Compare semantic-only against 1 and 2 hops on hit rate, citation validity and
latency. Ship hops on by default only if 1-hop improves multi-hop hit rate without hurting
single-passage questions.

## Open questions

1. Entity extraction quality and cost with a local model (Ollama) versus Claude. Is per-section
   extraction in the existing summarize call good enough?
2. Defaults for `k_seed`, `fanout`, `decay`, `max_degree` and the `similar` threshold. Tune them on
   the eval set.
3. Should `similar` links be precomputed (storage, ingestion cost) or computed at query time from
   seeds (latency)? Precomputing keeps queries cheap; start there.
4. OKF as an **export** format ("download my knowledge base"): documents become pages, and links
   become markdown links. Out of scope here; it's easy to add later because the links already exist.
