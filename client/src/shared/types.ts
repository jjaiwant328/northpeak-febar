/**
 * Types that cross the client/server boundary. Keep in sync with
 * server/db/queries/stores.ts + server/db/queries/chat.ts.
 *
 * NorthPeak Store Ops domain: the primary entity is a store×SKU POSITION
 * (a store's on-hand vs demand for one product). The Operations page shows
 * the open-shortfall queue + a store map; the drawer shows the ranked
 * recovery options (from the ML model) + an activity timeline built from
 * the writable `ops_actions` rows.
 *
 * The app is small enough that hand-copying these is simpler than a shared
 * package. When you swap the data model:
 *   1. Replace the entity types below.
 *   2. Update the matching queries in `server/db/queries/stores.ts`.
 *   3. Update the fetch helpers in `client/src/lib/stores.ts`.
 *   4. Status enums drive badges in `shared/badges.tsx` — keep aligned.
 */

/** The synced position row's status (from `gold_store_sku_position.position_status`,
 *  computed in SDP). Colors the map + the queue badge. */
export type PositionStatus = 'stockout' | 'at_risk' | 'overstock' | 'healthy';

/** The recovery move the ML model recommends (or that was executed). */
export type MoveType = 'transfer' | 'expedite' | 'substitute' | 'markdown_hold';

/** Lifecycle of a writable `ops_actions` row. */
export type ActionStatus = 'proposed' | 'approved' | 'executed' | 'overridden';

/**
 * One store×SKU position, as rendered in the Operations queue + map.
 * Read-only mirror of `gold_store_sku_position`, LEFT JOIN-ed to its
 * latest `ops_actions` row (so `liveMoveType`/`actionStatus` reflect the
 * writable table without mutating the synced position) and to
 * `recovery_recommendations` (the model's ranked move per shortfall).
 */
export type PositionRow = {
  /** Synthetic id `${storeId}:${productId}` — the queue's row key. */
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
  /** 0–1 from `ai_classify` in SDP (markdown risk on overstock rows). */
  markdownRiskScore: number | null;
  lostSalesExposureUsd: number | null;
  markdownExposureUsd: number | null;
  positionStatus: PositionStatus;
  /** The model's recommended move for this position (null until scored, or
   *  until the trainee's `gold_recovery_recommendations` table exists). */
  recommendedMove: MoveType | null;
  predictedRecapturedUsd: number | null;
  /** Live recovery state, from the position's latest `ops_actions` row.
   *  Non-null once the Act layer has recorded a move for this store×SKU. */
  liveMoveType: MoveType | null;
  actionStatus: ActionStatus | null;
};

/** The full move ranking the ML model produced for one shortfall
 *  (JSONB on `recovery_recommendations.move_ranking`). Each option carries
 *  the predicted recaptured $ + net value + cost, so the drawer + agent can
 *  render the ranked list and do the arithmetic what-if. */
export type MoveOption = {
  move: MoveType;
  units: number;
  costUsd: number;
  predictedRecapturedUsd: number;
  predictedNetValueUsd: number;
  sourceStoreId?: string | null;
  /** Overstock transfers flow the other direction — the shortfall store is
   *  the destination (live heuristic only). */
  destinationStoreId?: string | null;
  substituteProductId?: string | null;
};

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
  /** 'model' — ML-scored (shortfall rows). 'live' — computed at read time
   *  by the overstock heuristic. */
  basis: 'model' | 'live';
};

/** The nearest surplus store for a shortfall (from `gold_open_shortfalls`). */
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

export type AuditEntry = {
  at: string;
  by: string;
  action: 'proposed' | 'approved' | 'executed' | 'overridden' | 'markdown_hold' | 'note';
  notes?: string;
  tool?: string;
};

/** A recorded recovery action from the writable `ops_actions` table. */
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

/** Full detail for the drawer: the position + its shortfall context + the
 *  model's ranked recovery options + the recorded action rows (timeline). */
export type PositionDetail = {
  position: PositionRow;
  shortfall: Shortfall | null;
  recommendation: RecoveryRecommendation | null;
  actions: OpsAction[];
};

/** KPI rollup for the Operations page header. */
export type PositionSummary = {
  lostSalesExposureUsd: number;
  markdownExposureUsd: number;
  openShortfalls: number;
  recoveriesInProgress: number;
};

/** Per-store aggregation for the store map. One row per store with its
 *  coords, worst position status, and exposure. */
export type StoreBucket = {
  storeId: string;
  storeName: string | null;
  city: string | null;
  region: string | null;
  climateZone: string | null;
  lat: number;
  lng: number;
  /** Worst status across this store's affected positions — colors the dot. */
  status: PositionStatus;
  positions: number;
  recentVelocity: number;
  lostSalesExposureUsd: number;
  markdownExposureUsd: number;
};

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
