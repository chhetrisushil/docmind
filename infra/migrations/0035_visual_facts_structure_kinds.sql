-- 0035: visual_facts also holds the derived structure facts (spec docs/specs/2026-11-10-structure-diagrams-c1-design.md S7).
-- 0026's inline CHECKs were auto-named; the new ones keep those names. Ordinals 16 and 17 are reserved for structure facts.
ALTER TABLE visual_facts DROP CONSTRAINT visual_facts_kind_check;
ALTER TABLE visual_facts DROP CONSTRAINT visual_facts_ordinal_check;
ALTER TABLE visual_facts ADD CONSTRAINT visual_facts_kind_check
  CHECK (kind IN ('series', 'figure', 'factTable', 'outline', 'cooccurrence'));
ALTER TABLE visual_facts ADD CONSTRAINT visual_facts_ordinal_check CHECK (ordinal BETWEEN 0 AND 17);
