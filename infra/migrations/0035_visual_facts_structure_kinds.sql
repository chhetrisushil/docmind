-- 0035: visual_facts also holds the derived structure facts (spec docs/specs/2026-11-10-structure-diagrams-c1-design.md S7).
-- 0026's inline CHECKs were auto-named; the new ones keep those names. Ordinals 16 and 17 are reserved for structure facts.
ALTER TABLE visual_facts DROP CONSTRAINT visual_facts_kind_check;
ALTER TABLE visual_facts DROP CONSTRAINT visual_facts_ordinal_check;
ALTER TABLE visual_facts ADD CONSTRAINT visual_facts_kind_check
  CHECK (kind IN ('series', 'figure', 'factTable', 'outline', 'cooccurrence'));
ALTER TABLE visual_facts ADD CONSTRAINT visual_facts_ordinal_check CHECK (ordinal BETWEEN 0 AND 17);
-- The kind and the ordinal range must agree: the structure kinds live only at 16 and up, the extracted kinds only below.
-- Every existing row is series/figure/factTable at 0..15, so it satisfies this.
ALTER TABLE visual_facts ADD CONSTRAINT visual_facts_kind_ordinal_check
  CHECK ((kind IN ('outline', 'cooccurrence')) = (ordinal >= 16));
