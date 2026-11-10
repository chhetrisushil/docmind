-- 0037: visual_facts also holds the model's two aggregate facts, the timeline (ordinal 18) and the relations (ordinal 19)
-- (spec docs/specs/2026-11-10-structure-diagrams-c2-design.md D2, D6). 0026 and 0035 are never edited: their three CHECKs are
-- replaced here under the same names. The ordinal range widens to 0..19, and the kind/ordinal rule now pins every kind to its
-- own ordinal: the extracted kinds below 16, outline at 16, cooccurrence at 17, timeline at 18, relations at 19. 0035's rule was
-- `(kind IN ('outline','cooccurrence')) = (ordinal >= 16)`, which would refuse a timeline as an "extracted" row and let an
-- outline sit at 17. Every existing row satisfies the new rule: the structure step writes outline at 16 and cooccurrence at
-- 17 only, and the extracted kinds are below 16. No data changes; UNIQUE (tenant_id, document_id, ordinal) is untouched.
--
-- It also adds the extraction format stamp (spec D5, re-extract once): `documents.visual_extract_format`, the format of the
-- extraction that made the document's facts, set by the extraction write in the same transaction as the facts. NULL on every
-- existing document means "extracted before c2" (no backfill). A plain token, no content, so it is not sealed.
ALTER TABLE documents ADD COLUMN visual_extract_format text
  CHECK (visual_extract_format IS NULL OR length(visual_extract_format) <= 64);
ALTER TABLE visual_facts DROP CONSTRAINT visual_facts_kind_ordinal_check;
ALTER TABLE visual_facts DROP CONSTRAINT visual_facts_kind_check;
ALTER TABLE visual_facts DROP CONSTRAINT visual_facts_ordinal_check;
ALTER TABLE visual_facts ADD CONSTRAINT visual_facts_kind_check
  CHECK (kind IN ('series', 'figure', 'factTable', 'outline', 'cooccurrence', 'timeline', 'relations'));
ALTER TABLE visual_facts ADD CONSTRAINT visual_facts_ordinal_check CHECK (ordinal BETWEEN 0 AND 19);
ALTER TABLE visual_facts ADD CONSTRAINT visual_facts_kind_ordinal_check
  CHECK (
    (kind IN ('series', 'figure', 'factTable') AND ordinal < 16)
    OR (kind = 'outline' AND ordinal = 16)
    OR (kind = 'cooccurrence' AND ordinal = 17)
    OR (kind = 'timeline' AND ordinal = 18)
    OR (kind = 'relations' AND ordinal = 19)
  );
