-- gold_transfer_outcomes: recovery-move history with situational features
-- Training data for the recovery model (or heuristic coefficient source)

CREATE OR REFRESH MATERIALIZED VIEW gold_transfer_outcomes
AS
SELECT
  transfer_id,
  product_id,
  product_name,
  category,
  move_type,
  from_store_id,
  from_region,
  from_climate,
  to_store_id,
  to_region,
  to_climate,
  substitute_product_id,
  units_moved,
  initiated_date,
  days_to_fulfill,
  distance_km,
  price_usd,
  CASE
    WHEN price_usd > 0 THEN 1.0 - (cost_usd / price_usd)
    ELSE 0
  END AS margin_pct,
  recaptured_sales_usd,
  margin_impact_usd,
  transfer_cost_usd AS cost_usd,
  -- Derived: whether from and to are in the same region
  CASE WHEN from_region = to_region THEN TRUE ELSE FALSE END AS same_region
FROM silver_transfers
