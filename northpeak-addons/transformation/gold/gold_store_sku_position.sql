-- gold_store_sku_position: THE HEART — one row per (store, SKU) current position
-- silver_inventory (latest snapshot) LEFT JOIN 7-day silver_sales rollup
-- Computes velocity, weeks_of_supply, exposure metrics, and position_status

CREATE OR REFRESH MATERIALIZED VIEW gold_store_sku_position
CLUSTER BY (climate_zone, position_status)
AS
WITH latest_snapshot AS (
  SELECT *
  FROM (
    SELECT *,
      ROW_NUMBER() OVER (PARTITION BY store_id, product_id ORDER BY snapshot_date DESC, on_hand_units DESC) AS _rn
    FROM silver_inventory
  )
  WHERE _rn = 1
),
recent_sales AS (
  SELECT
    store_id,
    product_id,
    SUM(units_sold) AS recent_units_7d,
    SUM(net_sales_usd) AS recent_net_sales_7d
  FROM silver_sales
  WHERE sale_date >= (SELECT DATE_SUB(MAX(snapshot_date), 7) FROM silver_inventory)
  GROUP BY ALL
),
positions AS (
  SELECT
    inv.store_id,
    inv.store_name,
    inv.region,
    inv.climate_zone,
    inv.city,
    inv.store_lat,
    inv.store_lng,
    inv.product_id,
    inv.product_name,
    inv.category,
    inv.subcategory,
    inv.seasonality,
    inv.on_hand_units,
    inv.on_order_units,
    COALESCE(rs.recent_units_7d, 0) AS recent_units_7d,
    COALESCE(rs.recent_net_sales_7d, 0.0) AS recent_net_sales_7d,
    COALESCE(rs.recent_units_7d, 0) / 7.0 AS avg_daily_velocity,
    inv.price_usd,
    inv.markdown_risk_score
  FROM latest_snapshot inv
  LEFT JOIN recent_sales rs
    ON inv.store_id = rs.store_id AND inv.product_id = rs.product_id
)
SELECT
  store_id,
  store_name,
  region,
  climate_zone,
  city,
  store_lat,
  store_lng,
  product_id,
  product_name,
  category,
  subcategory,
  seasonality,
  on_hand_units,
  on_order_units,
  recent_units_7d,
  recent_net_sales_7d,
  avg_daily_velocity,
  CASE
    WHEN avg_daily_velocity > 0 THEN on_hand_units / (avg_daily_velocity * 7)
    ELSE NULL
  END AS weeks_of_supply,
  price_usd,
  markdown_risk_score,
  -- Lost-sales exposure: velocity × price × 30 days horizon for stocked-out positions
  CASE
    WHEN on_hand_units = 0 AND avg_daily_velocity > 0
    THEN GREATEST(0, avg_daily_velocity * price_usd * 30)
    ELSE 0
  END AS lost_sales_exposure_usd,
  -- Markdown exposure: surplus units × price × 0.3 markdown depth for overstock
  CASE
    WHEN avg_daily_velocity > 0
      AND (on_hand_units / (avg_daily_velocity * 7)) > 8
      AND markdown_risk_score >= 0.6
    THEN GREATEST(0, (on_hand_units - (avg_daily_velocity * 7 * 4)) * price_usd * 0.3)
    WHEN avg_daily_velocity = 0 AND on_hand_units > 0 AND markdown_risk_score >= 0.6
    THEN on_hand_units * price_usd * 0.3
    ELSE 0
  END AS markdown_exposure_usd,
  -- Position status flag
  CASE
    WHEN on_hand_units = 0 AND avg_daily_velocity > 0 THEN 'stockout'
    WHEN avg_daily_velocity > 0 AND (on_hand_units / (avg_daily_velocity * 7)) < 1 THEN 'at_risk'
    WHEN (
      (avg_daily_velocity > 0 AND (on_hand_units / (avg_daily_velocity * 7)) > 8)
      OR (avg_daily_velocity = 0 AND on_hand_units > 0)
    ) AND markdown_risk_score >= 0.6 THEN 'overstock'
    ELSE 'healthy'
  END AS position_status
FROM positions
