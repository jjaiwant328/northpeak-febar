-- gold_open_shortfalls: current stockout/at-risk positions enriched with nearest surplus
-- For each shortfall, find the nearest same-region overstock on the SAME SKU

CREATE OR REFRESH MATERIALIZED VIEW gold_open_shortfalls
AS
WITH shortfalls AS (
  SELECT *
  FROM gold_store_sku_position
  WHERE position_status IN ('stockout', 'at_risk')
),
surplus AS (
  SELECT
    store_id AS surplus_store_id,
    product_id AS surplus_product_id,
    region AS surplus_region,
    on_hand_units AS surplus_on_hand,
    store_lat AS surplus_lat,
    store_lng AS surplus_lng
  FROM gold_store_sku_position
  WHERE position_status = 'overstock'
),
nearest AS (
  SELECT
    sh.store_id,
    sh.product_id,
    su.surplus_store_id,
    su.surplus_on_hand,
    6371 * 2 * ASIN(SQRT(
      POWER(SIN(RADIANS(su.surplus_lat - sh.store_lat) / 2), 2) +
      COS(RADIANS(sh.store_lat)) * COS(RADIANS(su.surplus_lat)) *
      POWER(SIN(RADIANS(su.surplus_lng - sh.store_lng) / 2), 2)
    )) AS distance_km,
    ROW_NUMBER() OVER (
      PARTITION BY sh.store_id, sh.product_id
      ORDER BY 6371 * 2 * ASIN(SQRT(
        POWER(SIN(RADIANS(su.surplus_lat - sh.store_lat) / 2), 2) +
        COS(RADIANS(sh.store_lat)) * COS(RADIANS(su.surplus_lat)) *
        POWER(SIN(RADIANS(su.surplus_lng - sh.store_lng) / 2), 2)
      ))
    ) AS rn
  FROM shortfalls sh
  JOIN surplus su
    ON sh.product_id = su.surplus_product_id
    AND sh.region = su.surplus_region
)
SELECT
  sh.store_id,
  sh.store_name,
  sh.region,
  sh.climate_zone,
  sh.city,
  sh.store_lat,
  sh.store_lng,
  sh.product_id,
  sh.product_name,
  sh.category,
  sh.seasonality,
  sh.on_hand_units,
  sh.on_order_units,
  sh.recent_units_7d,
  sh.avg_daily_velocity,
  sh.price_usd,
  sh.lost_sales_exposure_usd,
  sh.position_status,
  nr.surplus_store_id AS nearest_surplus_store_id,
  nr.surplus_on_hand AS nearest_surplus_on_hand,
  nr.distance_km AS nearest_surplus_distance_km
FROM shortfalls sh
LEFT JOIN nearest nr
  ON sh.store_id = nr.store_id
  AND sh.product_id = nr.product_id
  AND nr.rn = 1
