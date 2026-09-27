import { sql } from 'drizzle-orm';
import { getExecutionContext } from '@databricks/appkit';
import type { AppDb } from './index.js';
import {
  storeSkuPosition,
  openShortfalls,
  recoveryRecommendations,
} from './schema.js';
import type { MoveOption } from './schema.js';

/**
 * One-shot Delta → Lakebase sync — NorthPeak Store Ops.
 *
 * > In production this is Lakebase Synced Tables (managed, continuous
 * > Delta→Lakebase replication with the same UC governance). For the demo
 * > build we keep it simple: a manual one-shot sync at boot, code we can
 * > show, no extra resource. Same outcome on screen.
 *
 * Pulls the three READ-ONLY Gold mirrors:
 *   - store_sku_position       (the affected + a sample of everyday positions)
 *   - open_shortfalls          (shortfall + nearest surplus)
 *   - recovery_recommendations (the ML model's ranked moves)
 *
 * `ops_actions` is the app's own WRITABLE table — never synced, starts empty.
 *
 * The recovery_recommendations table is BUILT BY THE TRAINEE (the ML step of
 * the workshop). So its query is fault-tolerant: if the table doesn't exist
 * yet, we log + leave the mirror empty rather than failing boot.
 *
 * Idempotent in the "only-if-destination-empty" sense — if the position
 * mirror has rows, we skip. Pass `{ forceIfAnyEmpty: true }` to re-sync
 * on demand (used by the "Reset demo" button).
 */

type DataConfig = {
  catalog: string;
  schema: string;
  tables: {
    /** gold_store_sku_position — one row per store×SKU with geo + status. */
    storeSkuPosition: string;
    /** gold_open_shortfalls — shortfall + nearest surplus store. */
    openShortfalls: string;
    /** gold_recovery_recommendations — the ML model's ranked moves.
     *  Built by the trainee; sync tolerates it not existing yet. */
    recoveryRecommendations?: string;
  };
};

export async function syncFromDelta(
  db: AppDb,
  cfg: DataConfig,
  opts: { forceIfAnyEmpty?: boolean } = {},
): Promise<void> {
  const hasRecoveryTable = Boolean(cfg.tables.recoveryRecommendations);
  const exists = await db.execute(
    sql`
      SELECT
        (SELECT COUNT(*)::int FROM app_v2.store_sku_position) AS positions,
        (SELECT COUNT(*)::int FROM app_v2.recovery_recommendations) AS recommendations
    `,
  );
  const counts = exists.rows[0] as
    | { positions: number; recommendations: number }
    | undefined;
  const coreReady = (counts?.positions ?? 0) > 0;
  const recommendationsReady =
    !hasRecoveryTable || (counts?.recommendations ?? 0) > 0;
  if (coreReady && recommendationsReady && !opts.forceIfAnyEmpty) return;

  const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID;
  if (!warehouseId) {
    console.warn('[sync] DATABRICKS_WAREHOUSE_ID not set — skipping Delta sync');
    return;
  }

  console.log('[sync] Starting Delta → Lakebase sync (parallel)…');
  const t0 = Date.now();

  const quoteIdentifier = (identifier: string) =>
    `\`${identifier.replace(/`/g, '``')}\``;
  const fq = (
    name: 'storeSkuPosition' | 'openShortfalls' | 'recoveryRecommendations',
  ) => {
    const table = cfg.tables[name];
    if (!table) throw new Error(`[sync] Missing configured table name for ${name}`);
    return [cfg.catalog, cfg.schema, table].map(quoteIdentifier).join('.');
  };

  // Fire the position + shortfall queries in parallel (the slow part). The
  // recovery-recommendations query is BEST-EFFORT (the trainee may not have
  // built that Gold table yet), so run it defensively and swallow a
  // TABLE_OR_VIEW_NOT_FOUND into an empty result.
  const [positionRows, shortfallRows, recoveryRows] = await Promise.all([
    execSqlPaged<{
      store_id: string;
      store_name: string | null;
      region: string | null;
      climate_zone: string | null;
      city: string | null;
      store_lat: number | null;
      store_lng: number | null;
      product_id: string;
      product_name: string | null;
      category: string | null;
      subcategory: string | null;
      seasonality: string | null;
      on_hand_units: number | null;
      on_order_units: number | null;
      recent_units_7d: number | null;
      recent_net_sales_7d: number | null;
      avg_daily_velocity: number | null;
      weeks_of_supply: number | null;
      price_usd: number | null;
      markdown_risk_score: number | null;
      lost_sales_exposure_usd: number | null;
      markdown_exposure_usd: number | null;
      position_status: string | null;
    }>(
      warehouseId,
      `SELECT store_id, store_name, region, climate_zone, city,
              store_lat, store_lng, product_id, product_name, category,
              subcategory, seasonality, on_hand_units, on_order_units,
              recent_units_7d, recent_net_sales_7d, avg_daily_velocity,
              weeks_of_supply, price_usd, markdown_risk_score,
              lost_sales_exposure_usd, markdown_exposure_usd, position_status
       FROM ${fq('storeSkuPosition')}
       ORDER BY store_id, product_id`,
    ),
    execSqlPaged<{
      store_id: string;
      product_id: string;
      on_hand_units: number | null;
      avg_daily_velocity: number | null;
      lost_sales_exposure_usd: number | null;
      nearest_surplus_store_id: string | null;
      nearest_surplus_on_hand: number | null;
      nearest_surplus_distance_km: number | null;
    }>(
      warehouseId,
      `SELECT store_id, product_id, on_hand_units, avg_daily_velocity,
              lost_sales_exposure_usd, nearest_surplus_store_id,
              nearest_surplus_on_hand, nearest_surplus_distance_km
       FROM ${fq('openShortfalls')}
       ORDER BY store_id, product_id`,
    ),
    hasRecoveryTable
      ? execSqlPaged<{
          store_id: string;
          product_id: string;
          recommended_move: string | null;
          recommended_source_store_id: string | null;
          recommended_substitute_product_id: string | null;
          recommended_units: number | null;
          predicted_recaptured_usd: number | null;
          predicted_net_value_usd: number | null;
          move_ranking: string | null;
          scored_at: string | null;
        }>(
          warehouseId,
          `SELECT store_id, product_id, recommended_move,
                  recommended_source_store_id, recommended_substitute_product_id,
                  recommended_units, predicted_recaptured_usd,
                  predicted_net_value_usd,
                  move_ranking, scored_at
           FROM ${fq('recoveryRecommendations')}
           ORDER BY store_id, product_id`,
        ).catch((e) => {
          // The trainee builds this table in the ML step — until then it
          // won't exist. Degrade gracefully so the app still boots + the
          // Visualize layer works; the agent's rank tool is the trainee's
          // Build-2 task anyway.
          console.warn(
            `[sync] recovery_recommendations not available yet (this is the trainee's ML step) — leaving that mirror empty: ${(e as Error).message}`,
          );
          return [] as never[];
        })
      : Promise.resolve([] as never[]),
  ]);
  console.log(
    `[sync]   queries done (${((Date.now() - t0) / 1000).toFixed(1)}s) — inserting…`,
  );

  if (positionRows.length) {
    await chunkInsert(positionRows, 2_000, (chunk) =>
      db
        .insert(storeSkuPosition)
        .values(
          chunk.map((r) => ({
            id: `${r.store_id}:${r.product_id}`,
            storeId: r.store_id,
            storeName: r.store_name,
            region: r.region,
            climateZone: r.climate_zone,
            city: r.city,
            storeLat: r.store_lat === null ? null : Number(r.store_lat),
            storeLng: r.store_lng === null ? null : Number(r.store_lng),
            productId: r.product_id,
            productName: r.product_name,
            category: r.category,
            subcategory: r.subcategory,
            seasonality: r.seasonality,
            onHandUnits: r.on_hand_units === null ? null : Number(r.on_hand_units),
            onOrderUnits: r.on_order_units === null ? null : Number(r.on_order_units),
            recentUnits7d: r.recent_units_7d === null ? null : Number(r.recent_units_7d),
            recentNetSales7d:
              r.recent_net_sales_7d === null ? null : Number(r.recent_net_sales_7d),
            avgDailyVelocity:
              r.avg_daily_velocity === null ? null : Number(r.avg_daily_velocity),
            weeksOfSupply: r.weeks_of_supply === null ? null : Number(r.weeks_of_supply),
            priceUsd: r.price_usd === null ? null : Number(r.price_usd),
            markdownRiskScore:
              r.markdown_risk_score === null ? null : Number(r.markdown_risk_score),
            lostSalesExposureUsd:
              r.lost_sales_exposure_usd === null
                ? null
                : Number(r.lost_sales_exposure_usd),
            markdownExposureUsd:
              r.markdown_exposure_usd === null ? null : Number(r.markdown_exposure_usd),
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            positionStatus: (r.position_status === 'stockout' ||
            r.position_status === 'at_risk' ||
            r.position_status === 'overstock'
              ? r.position_status
              : 'healthy') as 'stockout' | 'at_risk' | 'overstock' | 'healthy',
          })),
        )
        .onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   positions: ${positionRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  if (shortfallRows.length) {
    await chunkInsert(shortfallRows, 5_000, (chunk) =>
      db
        .insert(openShortfalls)
        .values(
          chunk.map((r) => ({
            id: `${r.store_id}:${r.product_id}`,
            storeId: r.store_id,
            productId: r.product_id,
            onHandUnits: r.on_hand_units === null ? null : Number(r.on_hand_units),
            avgDailyVelocity:
              r.avg_daily_velocity === null ? null : Number(r.avg_daily_velocity),
            lostSalesExposureUsd:
              r.lost_sales_exposure_usd === null
                ? null
                : Number(r.lost_sales_exposure_usd),
            nearestSurplusStoreId: r.nearest_surplus_store_id,
            nearestSurplusOnHand:
              r.nearest_surplus_on_hand === null
                ? null
                : Number(r.nearest_surplus_on_hand),
            nearestSurplusDistanceKm:
              r.nearest_surplus_distance_km === null
                ? null
                : Number(r.nearest_surplus_distance_km),
          })),
        )
        .onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   shortfalls: ${shortfallRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  if (recoveryRows.length) {
    await chunkInsert(recoveryRows, 5_000, (chunk) =>
      db
        .insert(recoveryRecommendations)
        .values(
          chunk.map((r) => ({
            id: `${r.store_id}:${r.product_id}`,
            storeId: r.store_id,
            productId: r.product_id,
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            recommendedMove: (r.recommended_move === 'transfer' ||
            r.recommended_move === 'expedite' ||
            r.recommended_move === 'substitute' ||
            r.recommended_move === 'markdown_hold'
              ? r.recommended_move
              : null) as
              | 'transfer'
              | 'expedite'
              | 'substitute'
              | 'markdown_hold'
              | null,
            recommendedSourceStoreId: r.recommended_source_store_id,
            recommendedSubstituteProductId: r.recommended_substitute_product_id,
            recommendedUnits:
              r.recommended_units === null ? null : Number(r.recommended_units),
            predictedRecapturedUsd:
              r.predicted_recaptured_usd === null
                ? null
                : Number(r.predicted_recaptured_usd),
            predictedNetValueUsd:
              r.predicted_net_value_usd === null
                ? null
                : Number(r.predicted_net_value_usd),
            moveRanking: parseMoveRanking(r.move_ranking),
          })),
        )
        .onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   recovery recommendations: ${recoveryRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[sync] Done in ${dt}s`);
}

/** `move_ranking` comes back as a JSON string (we `to_json(...)` it in SQL
 *  because the SQL Statements API serializes complex types as strings).
 *  Parse defensively — a malformed ranking just becomes []. */
function parseMoveRanking(raw: string | null): MoveOption[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as MoveOption[]) : [];
  } catch {
    return [];
  }
}

/**
 * Reset: truncate the app's writable table + chat state, then re-sync the
 * read-only mirrors. All agent writes are wiped — shortfalls return to
 * stockout/at_risk, exposure returns to full. Intentional: between
 * presentations Dana wants the backlog to look untouched.
 */
export async function wipeMirroredTables(db: AppDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE app_v2.feedback RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app_v2.messages RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app_v2.conversations RESTART IDENTITY CASCADE`);
    // The writable action table — the only place agent writes land.
    await tx.execute(sql`TRUNCATE TABLE app_v2.ops_actions RESTART IDENTITY CASCADE`);
    // Read-only mirrors — re-pulled by syncFromDelta after this.
    await tx.execute(sql`TRUNCATE TABLE app_v2.recovery_recommendations RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app_v2.open_shortfalls RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app_v2.store_sku_position RESTART IDENTITY CASCADE`);
  });
}

async function execSqlPaged<T>(
  warehouseId: string,
  statement: string,
  pageSize = 5_000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await execSql<T>(
      warehouseId,
      `${statement}\nLIMIT ${pageSize} OFFSET ${offset}`,
    );
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function execSql<T>(
  warehouseId: string,
  statement: string,
): Promise<T[]> {
  const { client } = getExecutionContext();
  type StmtResp = {
    statement_id: string;
    status: { state: string; error?: { message: string } };
    manifest?: {
      schema: { columns: Array<{ name: string }> };
      chunks?: Array<{ chunk_index: number; row_count: number }>;
    };
    result?: {
      chunk_index: number;
      row_count: number;
      data_array?: Array<Array<unknown>>;
      next_chunk_index?: number;
    };
  };

  const initial = (await client.apiClient.request({
    method: 'POST',
    path: '/api/2.0/sql/statements',
    payload: {
      statement,
      warehouse_id: warehouseId,
      wait_timeout: '50s',
      on_wait_timeout: 'CONTINUE',
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
    },
    headers: new Headers(),
    raw: false,
    query: {},
  })) as StmtResp;

  // Cap total polling at 10 minutes. The warehouse can take a couple of
  // minutes to spin from idle + scan, but a state stuck in RUNNING beyond
  // 10 min is broken — fail loud instead of silently blocking boot forever.
  const POLL_DEADLINE_MS = 10 * 60 * 1000;
  const startedAt = Date.now();

  let cur = initial;
  while (
    cur.status.state !== 'SUCCEEDED' &&
    cur.status.state !== 'FAILED' &&
    cur.status.state !== 'CANCELED'
  ) {
    if (Date.now() - startedAt > POLL_DEADLINE_MS) {
      throw new Error(
        `[sync] SQL still ${cur.status.state} after 10 minutes — aborting (statement_id=${cur.statement_id})`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
    cur = (await client.apiClient.request({
      method: 'GET',
      path: `/api/2.0/sql/statements/${cur.statement_id}`,
      headers: new Headers(),
      raw: false,
      query: {},
    })) as StmtResp;
  }
  if (cur.status.state !== 'SUCCEEDED') {
    throw new Error(
      `[sync] SQL failed: ${cur.status.error?.message ?? cur.status.state}`,
    );
  }

  const cols = cur.manifest?.schema.columns.map((c) => c.name) ?? [];
  const rows: T[] = [];
  let chunk = cur.result;
  while (chunk) {
    for (const row of chunk.data_array ?? []) {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
      rows.push(obj as T);
    }
    if (chunk.next_chunk_index === undefined || chunk.next_chunk_index === null) break;
    chunk = (await client.apiClient.request({
      method: 'GET',
      path: `/api/2.0/sql/statements/${cur.statement_id}/result/chunks/${chunk.next_chunk_index}`,
      headers: new Headers(),
      raw: false,
      query: {},
    })) as StmtResp['result'];
  }
  return rows;
}

async function chunkInsert<T>(
  rows: T[],
  size: number,
  fn: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await fn(rows.slice(i, i + size));
  }
}
