-- Position mix: count of positions by climate zone × status on the affected
-- SKUs. North = mostly stockout, South = mostly overstock — the split in one
-- grouped bar. Reads the Gold position table directly.
-- @param catalog STRING = rtdemo
-- @param schema STRING = demo-northpeak
SELECT
  p.climate_zone,
  p.position_status,
  CAST(COUNT(*) AS BIGINT) AS position_count
FROM IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`gold_store_sku_position`') p
WHERE p.product_id IN (
    'SKU-APP-04412', 'SKU-APP-04418', 'SKU-APP-04431',
    'SKU-APP-04455', 'SKU-APP-04460'
  )
  AND p.position_status <> 'healthy'
GROUP BY p.climate_zone, p.position_status
ORDER BY p.climate_zone, p.position_status
