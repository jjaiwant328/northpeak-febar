import { sql, eq, and } from 'drizzle-orm';
import type { AppDb } from '../index.js';
import { opsActions } from '../schema.js';
import type { AuditEntry, MoveOption } from '../schema.js';

export type { AuditEntry, MoveOption };

export type PositionStatus = 'stockout' | 'at_risk' | 'overstock' | 'healthy';
export type MoveType = 'transfer' | 'expedite' | 'substitute' | 'markdown_hold';
export type ActionStatus = 'proposed' | 'approved' | 'executed' | 'overridden';

// ============================================================================
// PositionRow — the Operations queue's primary entity. Reads the synced
// read-only position mirror, LEFT JOIN-ed to its LATEST ops_actions row
// (so `live_move_type` / `action_status` reflect the writable table) and
// to recovery_recommendations (the model's recommended move per shortfall).
// ============================================================================

export type PositionRow = {
  id: string;
  storeId: string;
  storeName: string | null;
  region: string | null;
  climateZone: string | null;
  city: string | null;
  storeLat: number | null;
  storeLng: number | null;
  productId: string;
  productName: string | null;
  category: string | null;
  seasonality: string | null;
  onHandUnits: number | null;
  onOrderUnits: number | null;
  recentUnits7d: number | null;
  avgDailyVelocity: number | null;
  weeksOfSupply: number | null;
  priceUsd: number | null;
  markdownRiskScore: number | null;
  lostSalesExposureUsd: number | null;
  markdownExposureUsd: number | null;
  positionStatus: PositionStatus;
  recommendedMove: MoveType | null;
  predictedRecapturedUsd: number | null;
  liveMoveType: MoveType | null;
  actionStatus: ActionStatus | null;
};

type PositionSqlRow = {
  id: string;
  store_id: string;
  store_name: string | null;
  region: string | null;
  climate_zone: string | null;
  city: string | null;
  store_lat: number | string | null;
  store_lng: number | string | null;
  product_id: string;
  product_name: string | null;
  category: string | null;
  seasonality: string | null;
  on_hand_units: number | null;
  on_order_units: number | null;
  recent_units_7d: number | null;
  avg_daily_velocity: number | string | null;
  weeks_of_supply: number | string | null;
  price_usd: number | string | null;
  markdown_risk_score: number | string | null;
  lost_sales_exposure_usd: number | string | null;
  markdown_exposure_usd: number | string | null;
  position_status: string | null;
  recommended_move: string | null;
  predicted_recaptured_usd: number | string | null;
  live_move_type: string | null;
  action_status: string | null;
};

const num = (v: number | string | null): number | null =>
  v === null || v === undefined ? null : Number(v);

const asStatus = (v: string | null): PositionStatus =>
  v === 'stockout' || v === 'at_risk' || v === 'overstock' ? v : 'healthy';

const asMove = (v: string | null): MoveType | null =>
  v === 'transfer' || v === 'expedite' || v === 'substitute' || v === 'markdown_hold'
    ? v
    : null;

const asActionStatus = (v: string | null): ActionStatus | null =>
  v === 'proposed' || v === 'approved' || v === 'executed' || v === 'overridden'
    ? v
    : null;

/**
 * `move_ranking` JSONB rows are written by the ML notebook with snake_case
 * keys (`cost_usd`, `predicted_recaptured_usd`, …), while MoveOption (and
 * the client's ShortfallTab) expect camelCase. The boot sync stores the JSON
 * verbatim, so normalize HERE at the read boundary — accept either key
 * style; camelCase rows pass through unchanged.
 */
const asMoveOption = (raw: unknown): MoveOption | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const move = asMove(typeof r.move === 'string' ? r.move : null);
  if (!move) return null;
  const pickNum = (camel: string, snake: string): number | null =>
    num(((r[camel] ?? r[snake]) as number | string | null) ?? null);
  const pickStr = (camel: string, snake: string): string | null => {
    const v = r[camel] ?? r[snake];
    return v === undefined || v === null ? null : String(v);
  };
  return {
    move,
    units: pickNum('units', 'units') ?? 0,
    costUsd: pickNum('costUsd', 'cost_usd') ?? 0,
    predictedRecapturedUsd: pickNum('predictedRecapturedUsd', 'predicted_recaptured_usd') ?? 0,
    predictedNetValueUsd: pickNum('predictedNetValueUsd', 'predicted_net_value_usd') ?? 0,
    sourceStoreId: pickStr('sourceStoreId', 'source_store_id'),
    substituteProductId: pickStr('substituteProductId', 'substitute_product_id'),
  };
};

const normalizeMoveRanking = (raw: unknown): MoveOption[] =>
  Array.isArray(raw)
    ? raw.map(asMoveOption).filter((o): o is MoveOption => o !== null)
    : [];

function toPositionRow(r: PositionSqlRow): PositionRow {
  return {
    id: r.id,
    storeId: r.store_id,
    storeName: r.store_name,
    region: r.region,
    climateZone: r.climate_zone,
    city: r.city,
    storeLat: num(r.store_lat),
    storeLng: num(r.store_lng),
    productId: r.product_id,
    productName: r.product_name,
    category: r.category,
    seasonality: r.seasonality,
    onHandUnits: r.on_hand_units === null ? null : Number(r.on_hand_units),
    onOrderUnits: r.on_order_units === null ? null : Number(r.on_order_units),
    recentUnits7d: r.recent_units_7d === null ? null : Number(r.recent_units_7d),
    avgDailyVelocity: num(r.avg_daily_velocity),
    weeksOfSupply: num(r.weeks_of_supply),
    priceUsd: num(r.price_usd),
    markdownRiskScore: num(r.markdown_risk_score),
    lostSalesExposureUsd: num(r.lost_sales_exposure_usd),
    markdownExposureUsd: num(r.markdown_exposure_usd),
    positionStatus: asStatus(r.position_status),
    recommendedMove: asMove(r.recommended_move),
    predictedRecapturedUsd: num(r.predicted_recaptured_usd),
    liveMoveType: asMove(r.live_move_type),
    actionStatus: asActionStatus(r.action_status),
  };
}

/**
 * The Operations queue. Reads store_sku_position, LEFT JOIN-ing:
 *   - the LATEST ops_actions row for that store×SKU (DISTINCT ON) → the
 *     live recovery state (move badge + "recovery in progress"),
 *   - recovery_recommendations → the model's recommended move.
 *
 * `statusGroup='open'` (default for the queue) filters to stockout/at_risk;
 * pass a specific `positionStatus`, a `climateZone`, or a `store`/`sku`
 * to narrow.
 */
export async function listPositions(
  db: AppDb,
  opts: {
    /** 'open' = stockout|at_risk (the shortfall backlog); 'all' = everything. */
    statusGroup?: 'open' | 'all';
    positionStatus?: PositionStatus;
    climateZone?: string;
    category?: string;
    store?: string;
    sku?: string;
    /** 'exposure' = ORDER BY lost_sales_exposure DESC (default);
     *  'velocity' = ORDER BY avg_daily_velocity DESC. */
    sort?: 'exposure' | 'velocity';
    limit?: number;
  } = {},
): Promise<PositionRow[]> {
  const limit = opts.limit ?? 300;
  const statusGroup = opts.statusGroup ?? 'open';

  const whereStatusGroup =
    opts.positionStatus
      ? sql`AND p.position_status = ${opts.positionStatus}`
      : statusGroup === 'open'
        ? sql`AND p.position_status IN ('stockout', 'at_risk')`
        : sql``;
  const whereZone = opts.climateZone
    ? sql`AND p.climate_zone = ${opts.climateZone}`
    : sql``;
  const whereCategory = opts.category ? sql`AND p.category = ${opts.category}` : sql``;
  const whereStore = opts.store ? sql`AND p.store_id = ${opts.store}` : sql``;
  const whereSku = opts.sku ? sql`AND p.product_id = ${opts.sku}` : sql``;
  const orderBy =
    opts.sort === 'velocity'
      ? sql`ORDER BY p.avg_daily_velocity DESC NULLS LAST`
      : sql`ORDER BY p.lost_sales_exposure_usd DESC NULLS LAST, p.markdown_exposure_usd DESC NULLS LAST`;

  const result = await db.execute(sql`
    SELECT
      p.id, p.store_id, p.store_name, p.region, p.climate_zone, p.city,
      p.store_lat, p.store_lng, p.product_id, p.product_name, p.category,
      p.seasonality, p.on_hand_units, p.on_order_units, p.recent_units_7d,
      p.avg_daily_velocity, p.weeks_of_supply, p.price_usd,
      p.markdown_risk_score, p.lost_sales_exposure_usd, p.markdown_exposure_usd,
      p.position_status,
      rr.recommended_move,
      rr.predicted_recaptured_usd,
      la.move_type AS live_move_type,
      la.status AS action_status
    FROM app_v2.store_sku_position p
    LEFT JOIN app_v2.recovery_recommendations rr
      ON rr.store_id = p.store_id AND rr.product_id = p.product_id
    LEFT JOIN LATERAL (
      SELECT a.move_type, a.status
      FROM app_v2.ops_actions a
      WHERE a.store_id = p.store_id AND a.product_id = p.product_id
        -- markdown_holds with units are PRIMARY approved moves on overstock
        -- stores (MODE C) and must show as recovery-in-progress. Only the
        -- paired zero-unit hold rows (transfer side-effects) stay hidden.
        AND (a.move_type <> 'markdown_hold' OR a.units > 0)
      ORDER BY a.created_at DESC
      LIMIT 1
    ) la ON true
    WHERE 1=1 ${whereStatusGroup} ${whereZone} ${whereCategory} ${whereStore} ${whereSku}
    ${orderBy}
    LIMIT ${limit}
  `);
  return (result.rows as PositionSqlRow[]).map(toPositionRow);
}

export async function getPosition(
  db: AppDb,
  id: string,
): Promise<PositionRow | null> {
  const result = await db.execute(sql`
    SELECT
      p.id, p.store_id, p.store_name, p.region, p.climate_zone, p.city,
      p.store_lat, p.store_lng, p.product_id, p.product_name, p.category,
      p.seasonality, p.on_hand_units, p.on_order_units, p.recent_units_7d,
      p.avg_daily_velocity, p.weeks_of_supply, p.price_usd,
      p.markdown_risk_score, p.lost_sales_exposure_usd, p.markdown_exposure_usd,
      p.position_status,
      rr.recommended_move,
      rr.predicted_recaptured_usd,
      la.move_type AS live_move_type,
      la.status AS action_status
    FROM app_v2.store_sku_position p
    LEFT JOIN app_v2.recovery_recommendations rr
      ON rr.store_id = p.store_id AND rr.product_id = p.product_id
    LEFT JOIN LATERAL (
      SELECT a.move_type, a.status
      FROM app_v2.ops_actions a
      WHERE a.store_id = p.store_id AND a.product_id = p.product_id
        -- markdown_holds with units are PRIMARY approved moves on overstock
        -- stores (MODE C) and must show as recovery-in-progress. Only the
        -- paired zero-unit hold rows (transfer side-effects) stay hidden.
        AND (a.move_type <> 'markdown_hold' OR a.units > 0)
      ORDER BY a.created_at DESC
      LIMIT 1
    ) la ON true
    WHERE p.id = ${id}
    LIMIT 1
  `);
  const row = result.rows[0] as PositionSqlRow | undefined;
  return row ? toPositionRow(row) : null;
}

// ============================================================================
// Shortfall — the shortfall + its nearest surplus (read-only mirror).
// ============================================================================

export type Shortfall = {
  storeId: string;
  productId: string;
  onHandUnits: number | null;
  avgDailyVelocity: number | null;
  lostSalesExposureUsd: number | null;
  nearestSurplusStoreId: string | null;
  nearestSurplusOnHand: number | null;
  nearestSurplusDistanceKm: number | null;
};

export async function getShortfall(
  db: AppDb,
  storeId: string,
  productId: string,
): Promise<Shortfall | null> {
  const res = await db.execute(sql`
    SELECT store_id, product_id, on_hand_units, avg_daily_velocity,
           lost_sales_exposure_usd, nearest_surplus_store_id,
           nearest_surplus_on_hand, nearest_surplus_distance_km
    FROM app_v2.open_shortfalls
    WHERE store_id = ${storeId} AND product_id = ${productId}
    LIMIT 1
  `);
  const r = res.rows[0] as
    | {
        store_id: string;
        product_id: string;
        on_hand_units: number | null;
        avg_daily_velocity: number | string | null;
        lost_sales_exposure_usd: number | string | null;
        nearest_surplus_store_id: string | null;
        nearest_surplus_on_hand: number | null;
        nearest_surplus_distance_km: number | string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    storeId: r.store_id,
    productId: r.product_id,
    onHandUnits: r.on_hand_units === null ? null : Number(r.on_hand_units),
    avgDailyVelocity: num(r.avg_daily_velocity),
    lostSalesExposureUsd: num(r.lost_sales_exposure_usd),
    nearestSurplusStoreId: r.nearest_surplus_store_id,
    nearestSurplusOnHand:
      r.nearest_surplus_on_hand === null ? null : Number(r.nearest_surplus_on_hand),
    nearestSurplusDistanceKm: num(r.nearest_surplus_distance_km),
  };
}

/**
 * The worst OPEN shortfall by lost-sales exposure. Used by the agent's
 * `find_shortfall` tool (Build 2) when the user doesn't name a store×SKU.
 * Ships as a helper so the trainee's tool has a ready query.
 */
export async function worstShortfall(db: AppDb): Promise<Shortfall | null> {
  const res = await db.execute(sql`
    SELECT store_id, product_id, on_hand_units, avg_daily_velocity,
           lost_sales_exposure_usd, nearest_surplus_store_id,
           nearest_surplus_on_hand, nearest_surplus_distance_km
    FROM app_v2.open_shortfalls
    ORDER BY lost_sales_exposure_usd DESC NULLS LAST
    LIMIT 1
  `);
  const r = res.rows[0] as
    | {
        store_id: string;
        product_id: string;
        on_hand_units: number | null;
        avg_daily_velocity: number | string | null;
        lost_sales_exposure_usd: number | string | null;
        nearest_surplus_store_id: string | null;
        nearest_surplus_on_hand: number | null;
        nearest_surplus_distance_km: number | string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    storeId: r.store_id,
    productId: r.product_id,
    onHandUnits: r.on_hand_units === null ? null : Number(r.on_hand_units),
    avgDailyVelocity: num(r.avg_daily_velocity),
    lostSalesExposureUsd: num(r.lost_sales_exposure_usd),
    nearestSurplusStoreId: r.nearest_surplus_store_id,
    nearestSurplusOnHand:
      r.nearest_surplus_on_hand === null ? null : Number(r.nearest_surplus_on_hand),
    nearestSurplusDistanceKm: num(r.nearest_surplus_distance_km),
  };
}

// ============================================================================
// RecoveryRecommendation — the ML model's ranked moves (read-only mirror).
// ============================================================================

export type RecoveryRecommendation = {
  storeId: string;
  productId: string;
  recommendedMove: MoveType | null;
  recommendedSourceStoreId: string | null;
  recommendedSubstituteProductId: string | null;
  recommendedUnits: number | null;
  predictedRecapturedUsd: number | null;
  predictedNetValueUsd: number | null;
  moveRanking: MoveOption[];
  /** 'model' — scored by the ML recovery_recommender (shortfall rows).
   *  'live' — computed at read time by the overstock heuristic below. */
  basis: 'model' | 'live';
};

export async function getRecommendation(
  db: AppDb,
  storeId: string,
  productId: string,
): Promise<RecoveryRecommendation | null> {
  const res = await db.execute(sql`
    SELECT store_id, product_id, recommended_move, recommended_source_store_id,
           recommended_substitute_product_id, recommended_units,
           predicted_recaptured_usd, predicted_net_value_usd, move_ranking
    FROM app_v2.recovery_recommendations
    WHERE store_id = ${storeId} AND product_id = ${productId}
    LIMIT 1
  `);
  const r = res.rows[0] as
    | {
        store_id: string;
        product_id: string;
        recommended_move: string | null;
        recommended_source_store_id: string | null;
        recommended_substitute_product_id: string | null;
        recommended_units: number | null;
        predicted_recaptured_usd: number | string | null;
        predicted_net_value_usd: number | string | null;
        move_ranking: MoveOption[] | null;
      }
    | undefined;
  if (!r) return synthesizeOverstockRecommendation(db, storeId, productId);
  return {
    storeId: r.store_id,
    productId: r.product_id,
    recommendedMove: asMove(r.recommended_move),
    recommendedSourceStoreId: r.recommended_source_store_id,
    recommendedSubstituteProductId: r.recommended_substitute_product_id,
    recommendedUnits: r.recommended_units === null ? null : Number(r.recommended_units),
    predictedRecapturedUsd: num(r.predicted_recaptured_usd),
    predictedNetValueUsd: num(r.predicted_net_value_usd),
    moveRanking: normalizeMoveRanking(r.move_ranking),
    basis: 'model',
  };
}

// ============================================================================
// Overstock recovery heuristic — the "markdown clock" side of the story.
//
// The ML model (recovery_recommender, Build 2) scores only the stockout
// shortfalls; gold_recovery_recommendations has no rows for OVERSTOCK
// surplus, so asking the agent to recover an overstock store previously hit
// "recovery data isn't available". When getRecommendation finds no model row,
// synthesize a LIVE ranking from position data: markdown_hold (planned
// clearance of the excess) vs transfer (to the worst open shortfall of the
// same SKU). Numbers are heuristics, marked basis:'live' so the agent quotes
// them as live-computed, not model-scored.
// ============================================================================

const OVERSTOCK_HEADING_WEEKS = 10; // "excess" = on-hand beyond ~10 weeks of supply
const FREIGHT_USD_PER_UNIT = 1.2;
const MARKDOWN_DISCOUNT = 0.3; // planned 30%-off clearance

const round2 = (v: number): number => Math.round(v * 100) / 100;

async function synthesizeOverstockRecommendation(
  db: AppDb,
  storeId: string,
  productId: string,
): Promise<RecoveryRecommendation | null> {
  // Only OVERSTOCK positions get the live heuristic — a missing model row
  // anywhere else (healthy, or an unscored shortfall) stays a genuine gap.
  const position = await getPosition(db, `${storeId}:${productId}`);
  if (!position || position.positionStatus !== 'overstock') return null;

  const velocity = position.avgDailyVelocity ?? 0;
  const price = position.priceUsd ?? 0;
  const heading = Math.ceil(velocity * OVERSTOCK_HEADING_WEEKS);
  const excess = Math.max(0, (position.onHandUnits ?? 0) - heading);
  if (excess <= 0 || price <= 0) return null;

  const options: MoveOption[] = [];

  // Option 1: markdown_hold — planned clearance of the excess at a discount.
  const mdRecaptured = excess * price * (1 - MARKDOWN_DISCOUNT);
  const mdCost = excess * price * MARKDOWN_DISCOUNT;
  options.push({
    move: 'markdown_hold',
    units: excess,
    costUsd: round2(mdCost),
    predictedRecapturedUsd: round2(mdRecaptured),
    predictedNetValueUsd: round2(mdRecaptured - mdCost),
    sourceStoreId: null,
    substituteProductId: null,
  });

  // Option 2: transfer to the worst open shortfall of the same SKU (if any).
  // From the overstock store's perspective the shortfall is the DESTINATION —
  // recorded via destinationStoreId (MoveOption.sourceStoreId stays
  // source-side semantics).
  const worst = await db.execute(sql`
    SELECT store_id, on_hand_units, avg_daily_velocity
    FROM app_v2.open_shortfalls
    WHERE product_id = ${productId}
    ORDER BY lost_sales_exposure_usd DESC NULLS LAST
    LIMIT 1
  `);
  const w = worst.rows[0] as
    | {
        store_id: string;
        on_hand_units: number | null;
        avg_daily_velocity: number | string | null;
      }
    | undefined;
  if (w) {
    const wVelocity = num(w.avg_daily_velocity) ?? 0;
    const need = Math.max(
      0,
      Math.ceil(wVelocity * OVERSTOCK_HEADING_WEEKS) - (w.on_hand_units ?? 0),
    );
    const transferUnits = Math.min(excess, need);
    if (transferUnits > 0) {
      const tRecaptured = transferUnits * price;
      const tCost = transferUnits * FREIGHT_USD_PER_UNIT;
      options.push({
        move: 'transfer',
        units: transferUnits,
        costUsd: round2(tCost),
        predictedRecapturedUsd: round2(tRecaptured),
        predictedNetValueUsd: round2(tRecaptured - tCost),
        sourceStoreId: null,
        destinationStoreId: w.store_id,
        substituteProductId: null,
      });
    }
  }

  options.sort((a, b) => b.predictedNetValueUsd - a.predictedNetValueUsd);
  const best = options[0];
  return {
    storeId,
    productId,
    recommendedMove: best.move,
    recommendedSourceStoreId: null,
    recommendedSubstituteProductId: null,
    recommendedUnits: best.units,
    predictedRecapturedUsd: best.predictedRecapturedUsd,
    predictedNetValueUsd: best.predictedNetValueUsd,
    moveRanking: options,
    basis: 'live',
  };
}

// ============================================================================
// OpsAction — the writable table (the app's own recovery-action records).
// ============================================================================

export type OpsAction = {
  id: string;
  storeId: string;
  productId: string;
  moveType: MoveType;
  sourceStoreId: string | null;
  units: number | null;
  draftedRequest: string | null;
  predictedRecapturedUsd: number | null;
  status: ActionStatus;
  approvedBy: string | null;
  auditTrail: AuditEntry[];
  createdAt: string;
  decidedAt: string | null;
};

type OpsActionSqlRow = {
  id: string;
  store_id: string;
  product_id: string;
  move_type: string;
  source_store_id: string | null;
  units: number | null;
  drafted_request: string | null;
  predicted_recaptured_usd: number | string | null;
  status: string;
  approved_by: string | null;
  audit_trail: AuditEntry[];
  created_at: string;
  decided_at: string | null;
};

function toOpsAction(r: OpsActionSqlRow): OpsAction {
  return {
    id: r.id,
    storeId: r.store_id,
    productId: r.product_id,
    moveType: (asMove(r.move_type) ?? 'transfer') as MoveType,
    sourceStoreId: r.source_store_id,
    units: r.units === null ? null : Number(r.units),
    draftedRequest: r.drafted_request,
    predictedRecapturedUsd: num(r.predicted_recaptured_usd),
    status: asActionStatus(r.status) ?? 'approved',
    approvedBy: r.approved_by,
    auditTrail: Array.isArray(r.audit_trail) ? r.audit_trail : [],
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

/** All recorded actions for a store×SKU (the drawer's Activity timeline). */
export async function listActionsForPosition(
  db: AppDb,
  storeId: string,
  productId: string,
): Promise<OpsAction[]> {
  const res = await db.execute(sql`
    SELECT id, store_id, product_id, move_type, source_store_id, units,
           drafted_request, predicted_recaptured_usd, status, approved_by,
           audit_trail, created_at, decided_at
    FROM app_v2.ops_actions
    WHERE store_id = ${storeId} AND product_id = ${productId}
    ORDER BY created_at DESC
  `);
  return (res.rows as OpsActionSqlRow[]).map(toOpsAction);
}

// ============================================================================
// KPI summary for the Operations header.
// ============================================================================

export type PositionSummary = {
  lostSalesExposureUsd: number;
  markdownExposureUsd: number;
  openShortfalls: number;
  recoveriesInProgress: number;
};

/**
 * KPI rollup. Lost-sales exposure sums OPEN shortfalls that DON'T yet have a
 * recovery action (so the number ticks down as the agent acts). Markdown
 * exposure sums overstock positions. Open shortfalls counts stockout/at_risk
 * positions without a recovery action; recoveries-in-progress counts the
 * ones that gained one.
 */
export async function positionSummary(db: AppDb): Promise<PositionSummary> {
  const res = await db.execute(sql`
    WITH acted AS (
      SELECT DISTINCT store_id, product_id
      FROM app_v2.ops_actions
      WHERE move_type <> 'markdown_hold'
    )
    SELECT
      COALESCE(SUM(p.lost_sales_exposure_usd) FILTER (
        WHERE p.position_status IN ('stockout','at_risk')
          AND a.store_id IS NULL
      ), 0)::float8 AS lost_sales_exposure_usd,
      COALESCE(SUM(p.markdown_exposure_usd) FILTER (
        WHERE p.position_status = 'overstock'
      ), 0)::float8 AS markdown_exposure_usd,
      COUNT(*) FILTER (
        WHERE p.position_status IN ('stockout','at_risk') AND a.store_id IS NULL
      )::int AS open_shortfalls,
      COUNT(*) FILTER (
        WHERE p.position_status IN ('stockout','at_risk') AND a.store_id IS NOT NULL
      )::int AS recoveries_in_progress
    FROM app_v2.store_sku_position p
    LEFT JOIN acted a
      ON a.store_id = p.store_id AND a.product_id = p.product_id
  `);
  const r = (res.rows[0] ?? {}) as {
    lost_sales_exposure_usd: number | string;
    markdown_exposure_usd: number | string;
    open_shortfalls: number;
    recoveries_in_progress: number;
  };
  return {
    lostSalesExposureUsd: Number(r.lost_sales_exposure_usd ?? 0),
    markdownExposureUsd: Number(r.markdown_exposure_usd ?? 0),
    openShortfalls: r.open_shortfalls ?? 0,
    recoveriesInProgress: r.recoveries_in_progress ?? 0,
  };
}

// ============================================================================
// Store-level aggregation for the store map. One row per store with coords,
// its WORST position status (colors the dot), and exposure. Same
// statusGroup/zone scope as the queue so map + table agree.
// ============================================================================

export type StoreBucket = {
  storeId: string;
  storeName: string | null;
  city: string | null;
  region: string | null;
  climateZone: string | null;
  lat: number;
  lng: number;
  status: PositionStatus;
  positions: number;
  recentVelocity: number;
  lostSalesExposureUsd: number;
  markdownExposureUsd: number;
};

export async function storeBreakdown(
  db: AppDb,
  opts: {
    statusGroup?: 'open' | 'all';
    positionStatus?: PositionStatus;
    climateZone?: string;
    limit?: number;
  } = {},
): Promise<StoreBucket[]> {
  const limit = opts.limit ?? 500;
  const statusGroup = opts.statusGroup ?? 'open';
  const whereStatusGroup = opts.positionStatus
    ? sql`AND p.position_status = ${opts.positionStatus}`
    : statusGroup === 'open'
      ? sql`AND p.position_status IN ('stockout', 'at_risk', 'overstock')`
      : sql``;
  const whereZone = opts.climateZone
    ? sql`AND p.climate_zone = ${opts.climateZone}`
    : sql``;

  // Worst-status ranking so the dot color reflects the store's most urgent
  // position: stockout > at_risk > overstock > healthy.
  const res = await db.execute(sql`
    SELECT
      p.store_id,
      MAX(p.store_name) AS store_name,
      MAX(p.city) AS city,
      MAX(p.region) AS region,
      MAX(p.climate_zone) AS climate_zone,
      AVG(p.store_lat)::float8 AS lat,
      AVG(p.store_lng)::float8 AS lng,
      COUNT(*)::int AS positions,
      COALESCE(SUM(p.recent_units_7d), 0)::float8 / 7.0 AS recent_velocity,
      COALESCE(SUM(p.lost_sales_exposure_usd), 0)::float8 AS lost_sales_exposure_usd,
      COALESCE(SUM(p.markdown_exposure_usd), 0)::float8 AS markdown_exposure_usd,
      MIN(
        CASE p.position_status
          WHEN 'stockout' THEN 0
          WHEN 'at_risk' THEN 1
          WHEN 'overstock' THEN 2
          ELSE 3
        END
      ) AS worst_rank
    FROM app_v2.store_sku_position p
    WHERE p.store_lat IS NOT NULL AND p.store_lng IS NOT NULL
      ${whereStatusGroup} ${whereZone}
    GROUP BY p.store_id
    ORDER BY lost_sales_exposure_usd DESC
    LIMIT ${limit}
  `);
  const RANK_TO_STATUS: PositionStatus[] = [
    'stockout',
    'at_risk',
    'overstock',
    'healthy',
  ];
  return (
    res.rows as Array<{
      store_id: string;
      store_name: string | null;
      city: string | null;
      region: string | null;
      climate_zone: string | null;
      lat: number | string;
      lng: number | string;
      positions: number;
      recent_velocity: number | string;
      lost_sales_exposure_usd: number | string;
      markdown_exposure_usd: number | string;
      worst_rank: number;
    }>
  ).map((r) => ({
    storeId: r.store_id,
    storeName: r.store_name,
    city: r.city,
    region: r.region,
    climateZone: r.climate_zone,
    lat: Number(r.lat),
    lng: Number(r.lng),
    status: RANK_TO_STATUS[r.worst_rank] ?? 'healthy',
    positions: r.positions,
    recentVelocity: Number(r.recent_velocity),
    lostSalesExposureUsd: Number(r.lost_sales_exposure_usd),
    markdownExposureUsd: Number(r.markdown_exposure_usd),
  }));
}

// ============================================================================
// Recent activity — the app's ops_actions rows, newest first. Powers the
// Home page activity feed.
// ============================================================================

export type ActivityEvent = {
  kind: 'action';
  action_id: string;
  store_id: string;
  product_id: string;
  at: string;
  by: string;
  move_type: MoveType;
  status: ActionStatus;
  units: number | null;
  predicted_recaptured_usd: number | null;
  notes: string | null;
};

export async function recentActivity(
  db: AppDb,
  limit = 20,
): Promise<ActivityEvent[]> {
  const res = await db.execute(sql`
    SELECT
      a.id AS action_id,
      a.store_id,
      a.product_id,
      COALESCE(a.decided_at, a.created_at) AS at,
      COALESCE(a.approved_by, 'system') AS by,
      a.move_type,
      a.status,
      a.units,
      a.predicted_recaptured_usd,
      a.drafted_request AS notes
    FROM app_v2.ops_actions a
    ORDER BY COALESCE(a.decided_at, a.created_at) DESC NULLS LAST
    LIMIT ${limit}
  `);
  return (
    res.rows as Array<{
      action_id: string;
      store_id: string;
      product_id: string;
      at: string;
      by: string;
      move_type: string;
      status: string;
      units: number | null;
      predicted_recaptured_usd: number | string | null;
      notes: string | null;
    }>
  ).map((r) => ({
    kind: 'action' as const,
    action_id: r.action_id,
    store_id: r.store_id,
    product_id: r.product_id,
    at: r.at,
    by: r.by,
    move_type: (asMove(r.move_type) ?? 'transfer') as MoveType,
    status: asActionStatus(r.status) ?? 'approved',
    units: r.units === null ? null : Number(r.units),
    predicted_recaptured_usd: num(r.predicted_recaptured_usd),
    notes: r.notes,
  }));
}

// ============================================================================
// recordRecoveryAction — the Act layer WRITE (Build 3). The ONLY place the
// app writes. Filter-driven + transactional (TEMPLATE_MAP pattern #5): inputs
// are a FILTER + drafted text, never a list of ids. Inserts the approved move
// into app_v2.ops_actions and — for a transfer — a paired 'markdown_hold' row on
// the SOURCE surplus store (so it isn't discounted while it feeds the
// transfer). On commit the caller emits `dataMutated` → the Operations page
// cascades live. See APP_WORKSHOP.md → "Layer 3 — Act".
// ============================================================================

export async function recordRecoveryAction(
  db: AppDb,
  args: {
    storeId: string;
    productId: string;
    moveType: 'transfer' | 'expedite' | 'substitute' | 'markdown_hold';
    units: number;
    sourceStoreId: string | null;
    draftedRequest: string;
    predictedRecapturedUsd: number;
    userEmail: string;
  },
): Promise<{ actionId: string; markdownHoldId: string | null }> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const nowIso = now.toISOString();

    // 1. The approved recovery move on the destination (short) store.
    const [action] = await tx
      .insert(opsActions)
      .values({
        storeId: args.storeId,
        productId: args.productId,
        moveType: args.moveType,
        sourceStoreId: args.sourceStoreId,
        units: args.units,
        draftedRequest: args.draftedRequest,
        predictedRecapturedUsd: args.predictedRecapturedUsd,
        status: 'approved',
        approvedBy: args.userEmail,
        decidedAt: now,
        auditTrail: [
          {
            at: nowIso,
            by: args.userEmail,
            action: 'approved',
            notes: 'Recovery move recorded',
            tool: 'execute_recovery_action',
          },
        ],
      })
      .returning({ id: opsActions.id });

    // 2. For a transfer, hold the SOURCE surplus so it isn't marked down while
    //    it feeds the transfer. Paired 'markdown_hold' row on the source store.
    let markdownHoldId: string | null = null;
    if (args.moveType === 'transfer' && args.sourceStoreId) {
      const [hold] = await tx
        .insert(opsActions)
        .values({
          storeId: args.sourceStoreId,
          productId: args.productId,
          moveType: 'markdown_hold',
          sourceStoreId: null,
          units: 0,
          draftedRequest: `Markdown hold on surplus feeding ${args.storeId} transfer`,
          predictedRecapturedUsd: 0,
          status: 'approved',
          approvedBy: args.userEmail,
          decidedAt: now,
          auditTrail: [
            {
              at: nowIso,
              by: args.userEmail,
              action: 'markdown_hold',
              notes: `Hold surplus at ${args.sourceStoreId} feeding ${args.storeId}`,
              tool: 'execute_recovery_action',
            },
          ],
        })
        .returning({ id: opsActions.id });
      markdownHoldId = hold.id;
    }

    return { actionId: action.id, markdownHoldId };
  });
}

// ============================================================================
// Two-stage Act workflow (FE Bar): draft → PROPOSED, approval → APPROVED.
// Phase 2 of the agent chain writes a 'proposed' row (visible in the queue as
// awaiting approval); Phase 3's execute flips the latest proposed row for the
// store×SKU to 'approved' (audit-appended), with the paired markdown_hold on
// a transfer's source — the same transaction shape as recordRecoveryAction.
// ============================================================================

export type ProposeArgs = {
  storeId: string;
  productId: string;
  moveType: 'transfer' | 'expedite' | 'substitute' | 'markdown_hold';
  units: number;
  sourceStoreId: string | null;
  draftedRequest: string;
  predictedRecapturedUsd: number;
  userEmail: string;
};

export async function proposeRecoveryAction(
  db: AppDb,
  args: ProposeArgs,
): Promise<{ actionId: string }> {
  const nowIso = new Date().toISOString();
  // Supersede any still-open drafts for this store×SKU: a redraft (e.g.
  // after the policy gate caps units) must not leave the old proposed row
  // in the awaiting-approval queue — the queue would keep showing the
  // superseded 137 next to the real 135.
  await db
    .update(opsActions)
    .set({
      status: 'overridden',
      decidedAt: new Date(),
      auditTrail: sql`${opsActions.auditTrail} || ${JSON.stringify([
        {
          at: nowIso,
          by: args.userEmail,
          action: 'overridden',
          notes: 'Superseded by a newer draft',
          tool: 'propose_recovery_action',
        },
      ])}::jsonb`,
    })
    .where(
      and(
        eq(opsActions.storeId, args.storeId),
        eq(opsActions.productId, args.productId),
        eq(opsActions.status, 'proposed'),
      ),
    );
  const [row] = await db
    .insert(opsActions)
    .values({
      storeId: args.storeId,
      productId: args.productId,
      moveType: args.moveType,
      sourceStoreId: args.sourceStoreId,
      units: args.units,
      draftedRequest: args.draftedRequest,
      predictedRecapturedUsd: args.predictedRecapturedUsd,
      status: 'proposed',
      approvedBy: args.userEmail,
      auditTrail: [
        {
          at: nowIso,
          by: args.userEmail,
          action: 'proposed',
          notes: 'Recovery move drafted — awaiting approval',
          tool: 'propose_recovery_action',
        },
      ],
    })
    .returning({ id: opsActions.id });
  return { actionId: row.id };
}

export async function approveRecoveryAction(
  db: AppDb,
  args: {
    storeId: string;
    productId: string;
    userEmail: string;
    /** The APPROVED move as confirmed by the human (and policy-capped). When
     * any field differs from the proposed row, the row is revised on approval
     * — otherwise a policy-capped 135 would approve the stale proposed 137. */
    revised?: {
      moveType?: string;
      units?: number;
      sourceStoreId?: string | null;
      predictedRecapturedUsd?: number;
    };
  },
): Promise<{
  actionId: string;
  markdownHoldId: string | null;
  moveType: string;
  units: number | null;
  sourceStoreId: string | null;
  predictedRecapturedUsd: number | null;
} | null> {
  return db.transaction(async (tx) => {
    const res = await tx.execute(sql`
      SELECT id, move_type, source_store_id, units, predicted_recaptured_usd, audit_trail
      FROM app_v2.ops_actions
      WHERE store_id = ${args.storeId} AND product_id = ${args.productId}
        AND status = 'proposed'
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `);
    const row = res.rows[0] as
      | {
          id: string;
          move_type: string;
          source_store_id: string | null;
          units: number | null;
          predicted_recaptured_usd: number | string | null;
          audit_trail: AuditEntry[] | null;
        }
      | undefined;
    if (!row) return null;

    // Effective values = proposed row overlaid with any approved revisions.
    const r = args.revised ?? {};
    const moveType = r.moveType ?? row.move_type;
    const units = r.units ?? row.units;
    const sourceStoreId =
      r.sourceStoreId !== undefined ? r.sourceStoreId : row.source_store_id;
    const predictedRecapturedUsd =
      r.predictedRecapturedUsd ?? num(row.predicted_recaptured_usd);

    const revisions: string[] = [];
    if (moveType !== row.move_type)
      revisions.push(`move_type ${row.move_type} → ${moveType}`);
    if (units !== row.units) revisions.push(`units ${row.units} → ${units}`);
    if (sourceStoreId !== row.source_store_id)
      revisions.push(`source_store_id ${row.source_store_id} → ${sourceStoreId}`);
    if (predictedRecapturedUsd !== num(row.predicted_recaptured_usd))
      revisions.push(
        `predicted_recaptured_usd ${row.predicted_recaptured_usd} → ${predictedRecapturedUsd}`,
      );

    const now = new Date();
    const trail: AuditEntry[] = [
      ...(Array.isArray(row.audit_trail) ? row.audit_trail : []),
      ...(revisions.length > 0
        ? [
            {
              at: now.toISOString(),
              by: args.userEmail,
              action: 'overridden',
              notes: `Revised on approval (policy/human-capped): ${revisions.join('; ')}`,
              tool: 'execute_recovery_action',
            } as AuditEntry,
          ]
        : []),
      {
        at: now.toISOString(),
        by: args.userEmail,
        action: 'approved',
        notes: 'Recovery move approved',
        tool: 'execute_recovery_action',
      },
    ];
    await tx
      .update(opsActions)
      .set({
        status: 'approved',
        decidedAt: now,
        auditTrail: trail,
        moveType: moveType as 'transfer' | 'expedite' | 'substitute' | 'markdown_hold',
        units,
        sourceStoreId,
        predictedRecapturedUsd,
      })
      .where(eq(opsActions.id, row.id));

    // Paired markdown-hold on the transfer's source surplus (same as the
    // direct-write path) — keyed off the EFFECTIVE (possibly revised) move.
    let markdownHoldId: string | null = null;
    if (moveType === 'transfer' && sourceStoreId) {
      const [hold] = await tx
        .insert(opsActions)
        .values({
          storeId: sourceStoreId,
          productId: args.productId,
          moveType: 'markdown_hold',
          sourceStoreId: null,
          units: 0,
          draftedRequest: `Markdown hold on surplus feeding ${args.storeId} transfer`,
          predictedRecapturedUsd: 0,
          status: 'approved',
          approvedBy: args.userEmail,
          decidedAt: now,
          auditTrail: [
            {
              at: now.toISOString(),
              by: args.userEmail,
              action: 'markdown_hold',
              notes: `Hold surplus at ${sourceStoreId} feeding ${args.storeId}`,
              tool: 'execute_recovery_action',
            },
          ],
        })
        .returning({ id: opsActions.id });
      markdownHoldId = hold.id;
    }

    return {
      actionId: row.id,
      markdownHoldId,
      moveType,
      units,
      sourceStoreId,
      predictedRecapturedUsd,
    };
  });
}

// ============================================================================
// searchProducts — hybrid product search over Lakebase Search (Milestone 2.4).
// Powers the agent's SUBSTITUTE recovery option: find a comparable in-stock
// item to offer when the requested SKU is sold out.
//
// `app_v2.products` carries two Lakebase Search structures over (name +
// description):
//   - search_tsv  (tsvector)   → BM25 keyword index `products_search_bm25`
//   - embedding   (vector 1024)→ ANN index `products_embedding_ann` (cosine)
// When a query embedding is supplied we FUSE the two rankings with Reciprocal
// Rank Fusion (RRF, k=60); with no embedding we fall back to BM25 keyword-only
// (still returns the right substitutes). Each candidate joins network on-hand
// from the store_sku_position snapshot (0 until Milestone 1 fills it).
// ============================================================================

export type ProductMatch = {
  product_id: string;
  product_name: string;
  category: string;
  price_usd: number;
  on_hand_units: number;
};

export async function searchProducts(
  db: AppDb,
  query: string,
  queryEmbedding: number[] | null = null,
  limit = 8,
): Promise<ProductMatch[]> {
  // BM25 relevance expression (lower/more-negative score = more relevant).
  const bm25 = sql`p.search_tsv <@> to_bm25query(to_tsvector('english', ${query}), 'app_v2.products_search_bm25'::regclass)`;

  // Network on-hand per product from the position snapshot (0 if none yet).
  const onHand = sql`
    LEFT JOIN (
      SELECT product_id, COALESCE(SUM(on_hand_units), 0)::int AS on_hand_units
      FROM app_v2.store_sku_position
      GROUP BY product_id
    ) oh ON oh.product_id = p.product_id`;

  let rows: Array<{
    product_id: string;
    product_name: string | null;
    category: string | null;
    price_usd: number | string | null;
    on_hand_units: number | string | null;
  }>;

  if (queryEmbedding && queryEmbedding.length) {
    // pgvector literal, e.g. '[0.1,0.2,...]', cast ::vector for the ANN op.
    const vecLiteral = `[${queryEmbedding.join(',')}]`;
    const res = await db.execute(sql`
      WITH kw AS (
        SELECT product_id, RANK() OVER (ORDER BY score ASC) AS rnk FROM (
          SELECT p.product_id, ${bm25} AS score
          FROM app_v2.products p
          WHERE p.is_active
          ORDER BY score ASC
          LIMIT 40
        ) k
      ),
      vec AS (
        SELECT product_id, RANK() OVER (ORDER BY dist ASC) AS rnk FROM (
          SELECT p.product_id, p.embedding <=> ${vecLiteral}::vector AS dist
          FROM app_v2.products p
          WHERE p.is_active
          ORDER BY dist ASC
          LIMIT 40
        ) v
      ),
      fused AS (
        SELECT COALESCE(kw.product_id, vec.product_id) AS product_id,
               COALESCE(1.0 / (60 + kw.rnk), 0) + COALESCE(1.0 / (60 + vec.rnk), 0) AS rrf
        FROM kw FULL OUTER JOIN vec ON kw.product_id = vec.product_id
      )
      SELECT p.product_id, p.product_name, p.category, p.price_usd,
             COALESCE(oh.on_hand_units, 0) AS on_hand_units
      FROM fused f
      JOIN app_v2.products p ON p.product_id = f.product_id
      ${onHand}
      ORDER BY f.rrf DESC, p.product_id
      LIMIT ${limit}
    `);
    rows = res.rows as typeof rows;
  } else {
    // Keyword-only fallback (no embedding available).
    const res = await db.execute(sql`
      SELECT p.product_id, p.product_name, p.category, p.price_usd,
             COALESCE(oh.on_hand_units, 0) AS on_hand_units
      FROM app_v2.products p
      ${onHand}
      WHERE p.is_active
      ORDER BY ${bm25} ASC
      LIMIT ${limit}
    `);
    rows = res.rows as typeof rows;
  }

  return rows.map((r) => ({
    product_id: r.product_id,
    product_name: r.product_name ?? r.product_id,
    category: r.category ?? '',
    price_usd: Number(r.price_usd ?? 0),
    on_hand_units: Number(r.on_hand_units ?? 0),
  }));
}
