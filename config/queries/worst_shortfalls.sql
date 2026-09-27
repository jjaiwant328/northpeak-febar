-- Worst open shortfalls by lost-sales exposure. Store 214 / Summit Down
-- Parka should sit near the top. Reads the Gold position table directly —
-- confirmed columns, resolves on any workspace.
-- @param catalog STRING = rtdemo
-- @param schema STRING = demo-northpeak
SELECT
  p.store_name,
  p.city,
  p.product_name,
  CAST(p.on_hand_units AS BIGINT) AS on_hand,
  CAST(ROUND(p.avg_daily_velocity, 2) AS DOUBLE) AS avg_daily_velocity,
  CAST(ROUND(COALESCE(p.lost_sales_exposure_usd, 0.0), 2) AS DOUBLE) AS lost_sales_exposure_usd
FROM IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`gold_store_sku_position`') p
WHERE p.position_status IN ('stockout', 'at_risk')
ORDER BY p.lost_sales_exposure_usd DESC NULLS LAST
LIMIT 20
