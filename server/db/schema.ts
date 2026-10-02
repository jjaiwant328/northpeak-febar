import {
  text,
  timestamp,
  uuid,
  integer,
  doublePrecision,
  jsonb,
  pgSchema,
  index,
  uniqueIndex,
  boolean,
} from 'drizzle-orm/pg-core';

/**
 * Lakebase schema, under `app_v2.*` — NorthPeak Store Ops v2.
 *
 * Three groups (synced READ-ONLY mirrors + ONE writable operational table):
 *   1. Chat state      (conversations, messages, feedback) — REUSE AS-IS.
 *                      Every use case has chat. The `thinking` + `error`
 *                      jsonb/text columns on `messages` make conversations
 *                      reload-safe with full reasoning trails preserved.
 *   2. Synced mirror   (store_sku_position, open_shortfalls,
 *                      recovery_recommendations) — READ-ONLY copies of the
 *                      Gold Delta tables that `db/sync.ts` pulls at boot.
 *                      In production these are Lakebase Synced Tables (the
 *                      manual sync is the demo stand-in). The app SELECTs
 *                      from them for sub-ms per-store reads; never writes.
 *   3. Write-surface   `ops_actions` — the ONLY table the app writes. A
 *                      UC synced table is read-only in Postgres, so the
 *                      Act layer records approved transfers / markdown
 *                      holds here. Append-only `audit_trail` JSONB makes
 *                      each action row a standalone timeline the drawer
 *                      Activity tab renders from one read.
 *
 * Why Lakebase: transactional Postgres semantics sitting next to the
 * lakehouse, with Unity Catalog governance. Lets the app do real
 * transactional writes while the analytics layer still queries Delta.
 */
export const appSchema = pgSchema('app_v2');

// ============================================================================
// Chat state
// ============================================================================

export const conversations = appSchema.table(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userEmail: text('user_email').notNull(),
    title: text('title').notNull(),
    // 'default' for regular chats, 'demo_dock' for the floating dock's
    // persistent conversation (one per user).
    kind: text('kind', { enum: ['default', 'demo_dock'] })
      .notNull()
      .default('default'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('conversations_user_idx').on(t.userEmail, t.updatedAt),
    index('conversations_kind_idx').on(t.userEmail, t.kind),
  ],
);

export const messages = appSchema.table(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),
    position: integer('position').notNull(),
    traceId: text('trace_id'),
    // Captured reasoning steps (tool calls, outputs, intermediate messages)
    // for assistant messages. Shape matches client's ThinkingEvent union.
    thinking: jsonb('thinking').$type<ThinkingEntry[]>().notNull().default([]),
    // If the agent run failed, the error message is persisted here so a
    // page reload still shows what went wrong (instead of an empty bubble).
    error: text('error'),
    // True when the turn was stopped by the user (Stop button or page
    // navigation away from an in-flight stream). The assistant's partial
    // streamed content is still kept in `content` for context; the UI
    // renders a "Canceled by the user" banner below it.
    canceled: boolean('canceled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Unique on (conversation_id, position) so the `SELECT MAX + 1` race in
    // appendMessage surfaces as a constraint error (caller retries) instead
    // of silently inserting two messages at the same position — which
    // would break the on-reload ordering. Doubles as the lookup index.
    uniqueIndex('messages_convo_pos_uq').on(t.conversationId, t.position),
  ],
);

export const feedback = appSchema.table(
  'feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userEmail: text('user_email').notNull(),
    value: text('value', { enum: ['up', 'down'] }).notNull(),
    rationale: text('rationale'),
    traceId: text('trace_id'),
    mlflowAssessmentId: text('mlflow_assessment_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('feedback_message_idx').on(t.messageId)],
);

// ============================================================================
// Synced read-only mirror (from Delta — NorthPeak Gold tables)
//
// These mirror `gold_store_sku_position`, `gold_open_shortfalls`, and
// `gold_recovery_recommendations` — UC synced
// tables, read-only from the app. `db/sync.ts` pulls them at boot; the
// app SELECTs from them and never writes them.
// ============================================================================

// `gold_store_sku_position` — one row per store×SKU. The Operations map +
// queue read this (filtered to the affected SKUs / open shortfalls). PK is
// the composite (store_id, product_id); we mirror it as a synthetic `id`
// `${store}:${product}` for the drizzle PK + the queue's row key.
export const storeSkuPosition = appSchema.table(
  'store_sku_position',
  {
    // Synthetic `${storeId}:${productId}`.
    id: text('id').primaryKey(),
    storeId: text('store_id').notNull(),
    storeName: text('store_name'),
    region: text('region'),
    climateZone: text('climate_zone'),
    city: text('city'),
    // Store coordinates — drive the Operations store map. DOUBLE PRECISION.
    storeLat: doublePrecision('store_lat'),
    storeLng: doublePrecision('store_lng'),
    productId: text('product_id').notNull(),
    productName: text('product_name'),
    category: text('category'),
    subcategory: text('subcategory'),
    seasonality: text('seasonality'),
    onHandUnits: integer('on_hand_units'),
    onOrderUnits: integer('on_order_units'),
    recentUnits7d: integer('recent_units_7d'),
    recentNetSales7d: doublePrecision('recent_net_sales_7d'),
    avgDailyVelocity: doublePrecision('avg_daily_velocity'),
    weeksOfSupply: doublePrecision('weeks_of_supply'),
    priceUsd: doublePrecision('price_usd'),
    // 0–1 from `ai_classify` in SDP — markdown risk on overstock rows.
    markdownRiskScore: doublePrecision('markdown_risk_score'),
    lostSalesExposureUsd: doublePrecision('lost_sales_exposure_usd'),
    markdownExposureUsd: doublePrecision('markdown_exposure_usd'),
    // 'stockout' | 'at_risk' | 'overstock' | 'healthy' — the UI colors the
    // map + badges by this.
    positionStatus: text('position_status', {
      enum: ['stockout', 'at_risk', 'overstock', 'healthy'],
    })
      .notNull()
      .default('healthy'),
  },
  (t) => [
    index('position_store_idx').on(t.storeId),
    index('position_status_idx').on(t.positionStatus),
    index('position_product_idx').on(t.productId),
  ],
);

// `gold_open_shortfalls` — the shortfall + its nearest surplus store. PK
// is the composite (store_id, product_id); mirrored as synthetic `id`.
export const openShortfalls = appSchema.table(
  'open_shortfalls',
  {
    id: text('id').primaryKey(), // `${storeId}:${productId}`
    storeId: text('store_id').notNull(),
    productId: text('product_id').notNull(),
    onHandUnits: integer('on_hand_units'),
    avgDailyVelocity: doublePrecision('avg_daily_velocity'),
    lostSalesExposureUsd: doublePrecision('lost_sales_exposure_usd'),
    nearestSurplusStoreId: text('nearest_surplus_store_id'),
    nearestSurplusOnHand: integer('nearest_surplus_on_hand'),
    nearestSurplusDistanceKm: doublePrecision('nearest_surplus_distance_km'),
  },
  (t) => [index('shortfall_store_idx').on(t.storeId)],
);

// Read-only mirror of the ML model's batch predictions table
// (`{catalog}.{schema}.gold_recovery_recommendations`, written by the ML
// notebook). The app never calls the model
// directly — the agent's `rank_recovery_moves` tool reads from this table.
// `moveRanking` (JSONB) holds all three options with predicted recaptured $
// + net $ + cost, powering the ranked-options list + the arithmetic what-if.
//
// NOTE: this table is produced by the ML train+score notebook,
// so sync.ts tolerates it not existing yet — the mirror is simply empty
// until the first scoring run lands it.
export const recoveryRecommendations = appSchema.table(
  'recovery_recommendations',
  {
    id: text('id').primaryKey(), // `${storeId}:${productId}`
    storeId: text('store_id').notNull(),
    productId: text('product_id').notNull(),
    recommendedMove: text('recommended_move', {
      enum: ['transfer', 'expedite', 'substitute', 'markdown_hold'],
    }),
    recommendedSourceStoreId: text('recommended_source_store_id'),
    recommendedSubstituteProductId: text('recommended_substitute_product_id'),
    recommendedUnits: integer('recommended_units'),
    predictedRecapturedUsd: doublePrecision('predicted_recaptured_usd'),
    predictedNetValueUsd: doublePrecision('predicted_net_value_usd'),
    // All three options with predicted recaptured $ + net $ + cost.
    moveRanking: jsonb('move_ranking').$type<MoveOption[]>().notNull().default([]),
    scoredAt: timestamp('scored_at', { withTimezone: true }),
  },
  (t) => [index('recovery_store_idx').on(t.storeId)],
);

// ============================================================================
// Writable operational table (the only table the app writes)
//
// `ops_actions` is the ONLY table the app writes. An approved transfer
// inserts a row here (move + drafted request + who approved); a markdown-
// hold on the source surplus inserts a paired `markdown_hold` row. The
// Operations queue derives a position's live state by LEFT JOIN-ing
// `store_sku_position` → its latest `ops_actions` row (so "recovery in
// progress" + the move badge come from the writable table, and the
// read-only synced position is never mutated). The append-only
// `audit_trail` makes each row a standalone timeline for the drawer.
// ============================================================================

export const opsActions = appSchema.table(
  'ops_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: text('store_id').notNull(),
    productId: text('product_id').notNull(),
    moveType: text('move_type', {
      enum: ['transfer', 'expedite', 'substitute', 'markdown_hold'],
    }).notNull(),
    sourceStoreId: text('source_store_id'),
    units: integer('units'),
    // The transfer / markdown memo the agent drafted.
    draftedRequest: text('drafted_request'),
    predictedRecapturedUsd: doublePrecision('predicted_recaptured_usd'),
    status: text('status', {
      enum: ['proposed', 'approved', 'executed', 'overridden'],
    })
      .notNull()
      .default('approved'),
    // OBO-stamped viewing user's email.
    approvedBy: text('approved_by'),
    // Append-only audit trail. Each entry: { at, by, action, notes?, tool? }
    auditTrail: jsonb('audit_trail').$type<AuditEntry[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    index('ops_actions_store_idx').on(t.storeId, t.productId),
    index('ops_actions_created_idx').on(t.createdAt),
  ],
);

// ============================================================================
// JSONB entry shapes
// ============================================================================

/** One option in the ranked recovery list (on
 *  `recovery_recommendations.move_ranking`, or live-computed for overstock
 *  positions). */
export type MoveOption = {
  move: 'transfer' | 'expedite' | 'substitute' | 'markdown_hold';
  units: number;
  costUsd: number;
  predictedRecapturedUsd: number;
  predictedNetValueUsd: number;
  sourceStoreId?: string | null;
  /** Overstock transfers flow the OTHER direction — the shortfall store is
   *  the destination (live heuristic only; model rows leave it unset). */
  destinationStoreId?: string | null;
  substituteProductId?: string | null;
};

export type AuditEntry = {
  at: string;
  by: string;
  action:
    | 'proposed'
    | 'approved'
    | 'executed'
    | 'overridden'
    | 'markdown_hold'
    | 'note';
  notes?: string;
  tool?: string;
};

export type ThinkingEntry =
  | { kind: 'tool_call'; callId: string; name: string; args: string }
  | { kind: 'tool_output'; callId: string; output: string }
  | { kind: 'intermediate_message'; text: string };
