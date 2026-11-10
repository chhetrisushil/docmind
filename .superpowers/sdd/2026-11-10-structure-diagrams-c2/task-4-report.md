# Task 4 report: extraction wiring

Implemented exactly as the brief specifies (tests first, red confirmed: 24 failures, flowHash test already green).

- prompts.ts: `EXTRACT_AGGREGATES` and `EXTRACT_DOCUMENT_SYSTEM`; `EXTRACT_SYSTEM` and `EXTRACT_INSTRUCTION` untouched (chat unchanged, byte-identical request asserted).
- extract.ts: `askWindows`, `askForExtraction`, `Extraction`, `aggregatesOf` (through `buildTimeline`/`buildRelations` only), `ExtractResult.aggregates`, rerun branch consults `aggregateCount`, write is `replace(ref, [...facts, ...aggregates], signal, generation)`. A refusal still clears via `replace(ref, [])`. Stamp shares the transaction (already in pgFacts from Task 2).
- limits.ts / deps.ts / compose.ts: `VISUALS_EXTRACT_MAX_TOKENS = 16_000`, `visualsExtractTimeoutMs` (`DOCMIND_VISUALS_EXTRACT_TIMEOUT_MS`, 180000, max 600000), `llm.visualsExtract`, `extractLlm`. Planner cap (8192) and timeout unchanged.
- flow.ts: zero-fact rule counts aggregates. Flow stays 1.1.0; flowHash.test.ts pins sha256:d3bfb104...
- Docs: README.org, .env.example, docs/operations/llm-providers.md.
- Preflight #4 test asserts no request carries "You extract facts" (no request counts).
- Biome reformatted three test/source files (`biome check --write`).
- No contradictions between brief, spec and code found.

## Fix round 1
- I1: `DocumentAnswer` is `.strip()` (facts stay strict per item); facts.test updated (it pinned the old strict behaviour).
- I2: `exhausted` also maps `StepTimeoutError` to `visuals-model-unavailable` (the step's time is its model calls; sizing the clock by window count would need a per-run timeout and the clock cannot move the flow hash). `extractEffect` honours `deps.stepTimeoutMs` (test seam). Tests: slow single window, slow multi-window.
- M1: source guard test that `extractLlm` appears once, before the chat deps. M2: per-window share of raw items (max(200/windows, 40)). M3: `earliestPassage` reads at most 8 ids. M4: comment wrapped. M5: `-1` case added.
- pgVectors.hnsw.pg.test failed once in the full run, passes alone (load flake, unrelated).
