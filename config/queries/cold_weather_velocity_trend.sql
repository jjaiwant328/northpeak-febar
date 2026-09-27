-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║ NorthPeak analytics — SQL-warehouse queries over the Gold Delta       ║
-- ║ tables. Tables are referenced via IDENTIFIER() built from :catalog +  ║
-- ║ :schema (bound at runtime by charts.ts) so the same SQL resolves on   ║
-- ║ any workspace. Register a query in charts.ts's QUERY_FILES map + ref   ║
-- ║ it from AnalyticsView.tsx.                                             ║
-- ╚══════════════════════════════════════════════════════════════════════╝
-- Cold-snap story, in one chart: weekly units sold on the 5 affected SKUs,
-- split by climate zone. Northern velocity ramps ~3 weeks ago while southern
-- stays flat — the divergence that drove the shortfall.
--
-- Reads silver_sales (the SDP pipeline's per-day sales fact — see
-- specifications/01-lakeflow.md). If your pipeline names it differently,
-- update the table + column names here.
-- @param catalog STRING = rtdemo
-- @param schema STRING = demo-northpeak
SELECT
  date_trunc('week', s.sale_date) AS week,
  s.climate_zone,
  CAST(SUM(s.units_sold) AS BIGINT) AS units_sold
FROM IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`silver_sales`') s
WHERE s.product_id IN (
    'SKU-APP-04412', 'SKU-APP-04418', 'SKU-APP-04431',
    'SKU-APP-04455', 'SKU-APP-04460'
  )
  AND s.sale_date >= date_sub(current_date(), 56)
GROUP BY date_trunc('week', s.sale_date), s.climate_zone
ORDER BY week
