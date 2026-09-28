-- silver_transfers: recovery-move history, denormalized with haversine distance
-- raw_transfers JOIN raw_products JOIN raw_stores (from + to)

CREATE OR REFRESH MATERIALIZED VIEW silver_transfers
AS
SELECT
  t.transfer_id,
  t.product_id,
  p.product_name,
  p.category,
  p.price_usd,
  p.cost_usd,
  t.move_type,
  t.from_store_id,
  sf.region AS from_region,
  sf.climate_zone AS from_climate,
  sf.store_lat AS from_lat,
  sf.store_lng AS from_lng,
  t.to_store_id,
  sto.region AS to_region,
  sto.climate_zone AS to_climate,
  sto.store_lat AS to_lat,
  sto.store_lng AS to_lng,
  t.substitute_product_id,
  t.units_moved,
  t.initiated_date,
  t.days_to_fulfill,
  t.recaptured_sales_usd,
  t.margin_impact_usd,
  t.cost_usd AS transfer_cost_usd,
  -- Haversine distance in km between from and to stores
  CASE
    WHEN t.from_store_id IS NOT NULL AND sf.store_lat IS NOT NULL AND sto.store_lat IS NOT NULL THEN
      6371 * 2 * ASIN(SQRT(
        POWER(SIN(RADIANS(sto.store_lat - sf.store_lat) / 2), 2) +
        COS(RADIANS(sf.store_lat)) * COS(RADIANS(sto.store_lat)) *
        POWER(SIN(RADIANS(sto.store_lng - sf.store_lng) / 2), 2)
      ))
    ELSE NULL
  END AS distance_km
FROM read_files('/Volumes/${catalog}/${schema}/raw_data/transfers') t
JOIN read_files('/Volumes/${catalog}/${schema}/raw_data/products') p
  ON t.product_id = p.product_id
LEFT JOIN read_files('/Volumes/${catalog}/${schema}/raw_data/stores') sf
  ON t.from_store_id = sf.store_id
JOIN read_files('/Volumes/${catalog}/${schema}/raw_data/stores') sto
  ON t.to_store_id = sto.store_id
