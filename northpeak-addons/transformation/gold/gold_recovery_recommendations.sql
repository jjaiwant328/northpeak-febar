-- gold_recovery_recommendations: ranked recovery move per open shortfall (heuristic)
-- For each shortfall, compute 3 candidate moves and rank by net_value

CREATE OR REFRESH MATERIALIZED VIEW gold_recovery_recommendations
AS
WITH shortfalls AS (
  SELECT
    store_id,
    product_id,
    avg_daily_velocity,
    price_usd,
    on_hand_units,
    nearest_surplus_store_id,
    nearest_surplus_on_hand,
    nearest_surplus_distance_km,
    -- Units needed: velocity × 14-day horizon minus on_hand
    GREATEST(1, CAST(CEIL(avg_daily_velocity * 14) - on_hand_units AS INT)) AS units_needed
  FROM gold_open_shortfalls
),
candidates AS (
  SELECT
    store_id,
    product_id,
    price_usd,
    nearest_surplus_store_id,
    nearest_surplus_on_hand,
    nearest_surplus_distance_km,
    -- Recommended units for transfer: min of need vs available surplus
    LEAST(units_needed, COALESCE(nearest_surplus_on_hand, 0)) AS transfer_units,
    units_needed,

    -- TRANSFER economics
    LEAST(units_needed, COALESCE(nearest_surplus_on_hand, 0)) * price_usd * 0.9
      * (1.0 - LEAST(0.3, COALESCE(nearest_surplus_distance_km, 500) / 1000.0))
      AS transfer_recaptured,
    60 + COALESCE(nearest_surplus_distance_km, 500) * 1.1 AS transfer_cost,
    0.0 AS transfer_margin_impact,

    -- EXPEDITE economics
    units_needed * price_usd * 0.82 AS expedite_recaptured,
    units_needed * 9.0 + 400 AS expedite_cost,
    0.0 AS expedite_margin_impact,

    -- SUBSTITUTE economics
    units_needed * price_usd * 0.35 AS substitute_recaptured,
    0.0 AS substitute_cost,
    units_needed * price_usd * 0.58 * 0.45 AS substitute_margin_impact

  FROM shortfalls
),
scored AS (
  SELECT
    store_id,
    product_id,
    price_usd,
    nearest_surplus_store_id,
    nearest_surplus_on_hand,
    nearest_surplus_distance_km,
    transfer_units,
    units_needed,

    -- Net values
    transfer_recaptured - transfer_cost - transfer_margin_impact AS transfer_net,
    expedite_recaptured - expedite_cost - expedite_margin_impact AS expedite_net,
    substitute_recaptured - substitute_cost - substitute_margin_impact AS substitute_net,

    transfer_recaptured,
    transfer_cost,
    expedite_recaptured,
    expedite_cost,
    substitute_recaptured,
    substitute_margin_impact
  FROM candidates
)
SELECT
  store_id,
  product_id,
  -- Pick argmax net_value
  CASE
    WHEN transfer_net >= expedite_net AND transfer_net >= substitute_net THEN 'transfer'
    WHEN expedite_net >= transfer_net AND expedite_net >= substitute_net THEN 'expedite'
    ELSE 'substitute'
  END AS recommended_move,
  CASE
    WHEN transfer_net >= expedite_net AND transfer_net >= substitute_net THEN nearest_surplus_store_id
    ELSE NULL
  END AS recommended_source_store_id,
  CAST(NULL AS STRING) AS recommended_substitute_product_id,
  CASE
    WHEN transfer_net >= expedite_net AND transfer_net >= substitute_net THEN transfer_units
    ELSE units_needed
  END AS recommended_units,
  CASE
    WHEN transfer_net >= expedite_net AND transfer_net >= substitute_net THEN transfer_recaptured
    WHEN expedite_net >= transfer_net AND expedite_net >= substitute_net THEN expedite_recaptured
    ELSE substitute_recaptured
  END AS predicted_recaptured_usd,
  CASE
    WHEN transfer_net >= expedite_net AND transfer_net >= substitute_net THEN transfer_net
    WHEN expedite_net >= transfer_net AND expedite_net >= substitute_net THEN expedite_net
    ELSE substitute_net
  END AS predicted_net_value_usd,
  -- JSON array of all three moves with their economics
  TO_JSON(ARRAY(
    NAMED_STRUCT(
      'move_type', 'transfer',
      'recaptured_usd', transfer_recaptured,
      'net_value_usd', transfer_net,
      'cost_usd', transfer_cost
    ),
    NAMED_STRUCT(
      'move_type', 'expedite',
      'recaptured_usd', expedite_recaptured,
      'net_value_usd', expedite_net,
      'cost_usd', expedite_cost
    ),
    NAMED_STRUCT(
      'move_type', 'substitute',
      'recaptured_usd', substitute_recaptured,
      'net_value_usd', substitute_net,
      'cost_usd', DOUBLE(0.0)
    )
  )) AS move_ranking,
  CURRENT_TIMESTAMP() AS scored_at
FROM scored
