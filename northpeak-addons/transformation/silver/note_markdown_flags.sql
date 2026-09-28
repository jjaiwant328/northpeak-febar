-- note_markdown_flags: ai_classify showcase — deduplicated to ~15 LLM calls
-- Classifies distinct merch_note_text into markdown risk scores

CREATE OR REFRESH MATERIALIZED VIEW note_markdown_flags
AS
SELECT
  merch_note_text,
  CASE ai_classify(merch_note_text, ARRAY('dead_stock', 'aging', 'healthy'))
    WHEN 'dead_stock' THEN 1.0
    WHEN 'aging'      THEN 0.6
    ELSE 0.1
  END AS markdown_risk_score
FROM (
  SELECT DISTINCT merch_note_text
  FROM read_files('/Volumes/${catalog}/${schema}/raw_data/inventory_snapshots')
  WHERE merch_note_text IS NOT NULL
)
