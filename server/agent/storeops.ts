/**
 * The store-ops action-taking agent — the app's defining piece.
 *
 * Built on `@openai/agents` (OpenAI Agents SDK) pointed at Databricks'
 * Responses API. Tools capture `db` + `userEmail` via closure so every
 * action is attributed to the viewing user (OBO).
 *
 * Tool surface:
 *   - `ask_data` — the investigation tool. Config-driven MAS-OR-Genie:
 *     uses the MAS endpoint if `masEndpointName` is set, else the Genie
 *     space if `genieSpaceId` is set.
 *   - `find_shortfall` / `rank_recovery_moves` — live reads over the
 *     Lakebase mirrors (ML-scored recommendations).
 *   - `simulate_recovery` — what-if projections, live-computed.
 *   - `propose_recovery_action` → `check_policy` → `execute_recovery_action`
 *     — the two-stage act layer: a drafted PROPOSED row, an independent
 *     policy verdict from the guarded AI Gateway endpoint (fail-closed),
 *     then a human-gated approve with a full audit trail.
 *
 * `configureAgentsSdk()` builds a PER-REQUEST Runner (never the SDK's
 * process-global client — concurrent streams would cross-authenticate) and
 * handles the Databricks Responses API wiring: the `Connection: close`
 * stale-socket workaround, the 64-char `input[*].id` strip, and the
 * transient-403 credential retry.
 */
import type { Request } from 'express';
import OpenAI from 'openai';
import {
  Agent,
  Runner,
  OpenAIProvider,
  setTracingDisabled,
} from '@openai/agents';
import type { Tool } from '@openai/agents';
import { loggedTool as tool } from './tools/logged-tool.js';
import * as mlflow from 'mlflow-tracing';
import { z } from 'zod';
import { authHeaders } from '../lib/auth.js';
import type { AppDb } from '../db/index.js';
// Lakebase query + write helpers. find_shortfall + rank_recovery_moves read
// the synced mirrors; execute_recovery_action writes via recordRecoveryAction
// / approveRecoveryAction. See server/db/queries/stores.ts.
import {
  getShortfall,
  worstShortfall,
  getPosition,
  getRecommendation,
  recordRecoveryAction,
  proposeRecoveryAction,
  approveRecoveryAction,
  searchProducts,
} from '../db/queries/stores.js';

/** Embedding endpoint used to populate `app.products.embedding` (1024-dim) —
 *  the runtime query MUST be embedded by the SAME model for the vector half
 *  of hybrid search to be meaningful. */
const EMBEDDING_MODEL = 'databricks-gte-large-en';

/**
 * Embed a search string via the Databricks FM API (OpenAI-compatible embeddings
 * shape). Returns the 1024-dim vector, or null on any failure so search_products
 * degrades to BM25 keyword-only instead of throwing.
 */
async function embedQuery(ctx: AgentContext, text: string): Promise<number[] | null> {
  try {
    const headers = await authHeaders(ctx.req);
    headers.set('Content-Type', 'application/json');
    const url = `${ctx.databricksHost}/serving-endpoints/${EMBEDDING_MODEL}/invocations`;
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ input: text }),
    });
    if (!resp.ok) {
      console.error(
        '[search_products] embedding call failed',
        resp.status,
        (await resp.text().catch(() => '')).slice(0, 300),
      );
      return null;
    }
    const json = (await resp.json()) as { data?: Array<{ embedding?: number[] }> };
    const emb = json.data?.[0]?.embedding;
    return Array.isArray(emb) ? emb : null;
  } catch (e) {
    console.error('[search_products] embedding threw', e);
    return null;
  }
}
// The data-backend helpers. Both are config-driven and share the same
// DataCallResult shape + ToolProgressEvent stream, so the `ask_data` tool
// below can delegate to EITHER without the UI caring which powers it. This
// preserves the MAS-OR-Genie flexibility exactly.
import { callMasEndpoint } from './tools/mas.js';
import { callGenieSpace } from './tools/genie.js';
export type { ToolProgressEvent } from './tools/types.js';

/** Captured detail of the last failing call to the model serving endpoint. */
export type ModelErrorDetail = {
  status: number;
  url: string;
  bodyText: string;
  code?: string;
  message?: string;
};

export type AgentContext = {
  db: AppDb;
  userEmail: string;
  req: Request;
  /** MAS serving-endpoint name the `ask_data` tool talks to WHEN SET. Set in
   * `config/app.json` as `masEndpointName` (env `MAS_ENDPOINT_NAME`). Leave
   * empty to use Genie instead — the app registers whichever is configured. */
  masEndpointName: string;
  /** Genie space id the `ask_data` tool talks to WHEN `masEndpointName` is
   * empty. Set as `genieSpaceId` (env `GENIE_SPACE_ID`). */
  genieSpaceId: string;
  databricksHost: string;
  model: string;
  /** Called by long-running tools to surface progress to the UI. */
  onToolProgress?: (ev: import('./tools/types.js').ToolProgressEvent) => void;
  /** Mutated by the OpenAI fetch shim on any non-2xx. */
  modelError?: { current: ModelErrorDetail | null };
  /** Per-request Runner built from the per-request OpenAI client in
   * `configureAgentsSdk`. NEVER the SDK's process-global default client —
   * two concurrent streams (dock + page, two tabs, two users) would swap
   * the global mid-run and authenticate user A's later model calls as
   * user B (a recurring source of spurious 403 Invalid Token). */
  runner?: Runner;
};

// ────────────────────────────────────────────────────────────────────────────
// Adding / editing tools — READ THIS before touching `parameters: z.object(...)`.
//
// The Agents SDK ships every tool's zod schema to the Responses API with
// `strict: true`. Strict mode requires EVERY property in `required`. So use
// `.nullable()`, NOT `.optional()`:
//   ❌  reason: z.string().optional()   // breaks with strict:true (masked 502)
//   ✅  reason: z.string().nullable()   // field required, value may be null
// Every field needs a `.describe(...)`. Keep property names snake_case.
// Use the `loggedTool` wrapper (imported as `tool`), not the raw SDK `tool`.
// ────────────────────────────────────────────────────────────────────────────
function makeTools(ctx: AgentContext): Tool[] {
  // ── ask_data — config-driven MAS-OR-Genie. ────────────────────────────────
  // Delegates to the MAS endpoint if one is configured, else the Genie space.
  // Both helpers return {answer, trace_id} and stream progress via
  // ctx.onToolProgress → the Thinking panel. Registered ONLY when a backend
  // is configured (otherwise the tool would 404 confusingly).
  const askData = tool({
    name: 'ask_data',
    description:
      'Investigate the governed lakehouse with a natural-language question — the tool generates SQL / retrieves knowledge and returns a synthesized answer. Use for any "why" / "what happened" / investigative question about store positions, sell-through, shortfalls, or surplus. Prefer ONE narrow, well-formed question over many small ones.',
    parameters: z.object({
      question: z
        .string()
        .describe(
          'A clear, focused English question about the data. Narrow questions finish in 20–40s; broad multi-part questions take longer.',
        ),
    }),
    execute: async ({ question }) =>
      mlflow.withSpan(
        async () =>
          ctx.masEndpointName
            ? callMasEndpoint(ctx, ctx.masEndpointName, question)
            : callGenieSpace(ctx, ctx.genieSpaceId, question),
        {
          name: 'ask_data',
          spanType: mlflow.SpanType.TOOL,
          inputs: { question },
        },
      ),
  });

  // ── find_shortfall — read the open shortfall for {store_id, product_id} ──
  // (or the worst one) from Lakebase app.open_shortfalls +
  // app.store_sku_position: on_hand, recent velocity, weeks_of_supply,
  // lost-sales exposure, AND the nearest surplus store + its on-hand +
  // distance. Queries live in server/db/queries/stores.ts (`getShortfall`,
  // `worstShortfall`, `getPosition`).
  const findShortfall = tool({
    name: 'find_shortfall',
    description:
      'Read the live shortfall for a store×SKU (or the worst open shortfall) from Lakebase: on-hand, recent velocity, weeks of supply, lost-sales exposure, and the nearest surplus store + its on-hand + distance. Read-only.',
    parameters: z.object({
      store_id: z
        .string()
        .nullable()
        .describe('Store id, e.g. STORE-0214. Null → return the worst open shortfall.'),
      product_id: z
        .string()
        .nullable()
        .describe('SKU, e.g. SKU-APP-04412. Null → return the worst open shortfall.'),
    }),
    execute: async ({ store_id, product_id }) =>
      mlflow.withSpan(
        async () => {
          // Both ids given → that store×SKU; otherwise the worst open shortfall.
          const sf =
            store_id && product_id
              ? await getShortfall(ctx.db, store_id, product_id)
              : await worstShortfall(ctx.db);
          if (!sf) return { found: false };
          // Enrich with the live position (store name, city, weeks of supply).
          const pos = await getPosition(ctx.db, `${sf.storeId}:${sf.productId}`);
          return {
            found: true,
            store_id: sf.storeId,
            product_id: sf.productId,
            store_name: pos?.storeName ?? null,
            city: pos?.city ?? null,
            on_hand_units: sf.onHandUnits,
            avg_daily_velocity: sf.avgDailyVelocity,
            weeks_of_supply: pos?.weeksOfSupply ?? null,
            lost_sales_exposure_usd: sf.lostSalesExposureUsd,
            nearest_surplus_store_id: sf.nearestSurplusStoreId,
            nearest_surplus_on_hand: sf.nearestSurplusOnHand,
            nearest_surplus_distance_km: sf.nearestSurplusDistanceKm,
          };
        },
        {
          name: 'find_shortfall',
          spanType: mlflow.SpanType.TOOL,
          inputs: { store_id, product_id },
        },
      ),
  });

  // ── rank_recovery_moves — read app.recovery_recommendations for ─────────
  // {store_id, product_id}: the model's recommended_move,
  // predicted_recaptured_usd, predicted_net_value_usd, and the full
  // move_ranking (all options with predicted recaptured $ + net $ + cost).
  // The agent quotes the ranked options + recommended move in the draft and
  // recomputes the what-if arithmetically from move_ranking. Query:
  // `getRecommendation` in stores.ts.
  const rankRecoveryMoves = tool({
    name: 'rank_recovery_moves',
    description:
      "Read the ranked recovery moves for a store×SKU. For SHORTFALL (stockout/at_risk) positions these are the ML model's scored moves from Lakebase app.recovery_recommendations (basis=model). For OVERSTOCK surplus positions the model has no rows, so the ranking is computed LIVE from position data (basis=live): markdown_hold (planned clearance of the excess) vs transfer to the worst open shortfall of the same SKU. Returns the recommended move, its predicted recaptured $ + net value, and the full ranking with each option's units, cost, predicted recaptured $ and net $. Read-only. Quote these in the draft (naming the basis); do the what-if arithmetically from the ranking.",
    parameters: z.object({
      store_id: z.string().describe('Store id, e.g. STORE-0214.'),
      product_id: z.string().describe('SKU, e.g. SKU-APP-04412.'),
    }),
    execute: async ({ store_id, product_id }) =>
      mlflow.withSpan(
        async () => {
          const rec = await getRecommendation(ctx.db, store_id, product_id);
          if (!rec) {
            // Not an overstock position and no model row either (e.g. a
            // healthy position, or an unscored shortfall) — return a note
            // the agent can explain instead of throwing.
            return {
              scored: false,
              note: 'No recovery recommendation for this position — the ML model scores shortfall (stockout/at_risk) positions, and this one is neither scored nor overstock.',
            };
          }
          return {
            store_id: rec.storeId,
            product_id: rec.productId,
            recommended_move: rec.recommendedMove,
            recommended_source_store_id: rec.recommendedSourceStoreId,
            recommended_units: rec.recommendedUnits,
            predicted_recaptured_usd: rec.predictedRecapturedUsd,
            predicted_net_value_usd: rec.predictedNetValueUsd,
            move_ranking: rec.moveRanking,
            basis: rec.basis,
          };
        },
        {
          name: 'rank_recovery_moves',
          spanType: mlflow.SpanType.TOOL,
          inputs: { store_id, product_id },
        },
      ),
  });

  // ── simulate_recovery — the What-If engine (live-computed, read-only). ──
  // For a store×SKU, build the side-by-side comparison the executive asks
  // for: BASELINE vs each recovery option (transfer / expedite / substitute
  // or markdown_hold for overstock), with units, freight cost, margin impact,
  // inventory days, and revenue-at-risk AFTER the move. Optional overrides:
  // units ("what if 40 instead of 60?") and demand_shock_pct ("what if demand
  // is 20% higher?") — velocity is scaled before everything recomputes.
  // Numbers are live-computed estimates from the move ranking + position
  // fields, labeled as such; the agent quotes them and marks the basis.
  const simulateRecovery = tool({
    name: 'simulate_recovery',
    description:
      'What-if simulator (read-only): for a store×SKU, compare BASELINE vs each recovery option side-by-side — revenue at risk after the move, margin impact, freight cost, inventory days, and expected recovery $. Supports overrides: units ("what if 40 units?") and demand_shock_pct ("what if demand is 20% higher?"). Numbers are live-computed estimates from the move ranking + live position data — say so when quoting them.',
    parameters: z.object({
      store_id: z.string().describe('Store id, e.g. STORE-0214.'),
      product_id: z.string().describe('SKU, e.g. SKU-APP-04412.'),
      move_type: z
        .enum(['transfer', 'expedite', 'substitute', 'markdown_hold'])
        .nullable()
        .describe('Simulate only this move; null → all options.'),
      units: z
        .number()
        .int()
        .nullable()
        .describe('Override the units to move; null → the ranked option’s units.'),
      demand_shock_pct: z
        .number()
        .nullable()
        .describe('Demand shock, e.g. 20 for +20% velocity; null → as-is.'),
    }),
    execute: async ({ store_id, product_id, move_type, units, demand_shock_pct }) =>
      mlflow.withSpan(
        async () => {
          const [position, recommendation] = await Promise.all([
            getPosition(ctx.db, `${store_id}:${product_id}`),
            getRecommendation(ctx.db, store_id, product_id),
          ]);
          if (!position) return { simulated: false, note: 'Position not found.' };

          const shock = demand_shock_pct ? 1 + demand_shock_pct / 100 : 1;
          const velocity = (position.avgDailyVelocity ?? 0) * shock;
          const exposureNow = (position.lostSalesExposureUsd ?? 0) * shock;
          const markdownNow = position.markdownExposureUsd ?? 0;
          const invDaysNow =
            velocity > 0 ? Math.round(((position.onHandUnits ?? 0) / velocity) * 10) / 10 : null;

          const options = (recommendation?.moveRanking ?? []).filter(
            (o) => !move_type || o.move === move_type,
          );
          if (!options.length) {
            return {
              simulated: false,
              note: 'No recovery options to simulate — run rank_recovery_moves first.',
            };
          }

          const rows = options.map((o) => {
            const u = units ?? o.units;
            const scale = o.units > 0 ? u / o.units : 1;
            const recovery = o.predictedRecapturedUsd * scale;
            const cost = o.costUsd * scale;
            const net = o.predictedNetValueUsd * scale;
            return {
              move: o.move,
              units: u,
              revenue_risk_after_usd: Math.max(0, Math.round(exposureNow - recovery)),
              expected_recovery_usd: Math.round(recovery),
              freight_cost_usd: Math.round(o.move === 'transfer' || o.move === 'expedite' ? cost : 0),
              margin_impact_usd: Math.round(net - (recovery - cost)),
              net_value_usd: Math.round(net),
              inventory_days_after:
                velocity > 0
                  ? Math.round((((position.onHandUnits ?? 0) + u) / velocity) * 10) / 10
                  : null,
              source_store_id: o.sourceStoreId ?? null,
              destination_store_id: o.destinationStoreId ?? null,
            };
          });
          rows.sort((a, b) => b.net_value_usd - a.net_value_usd);

          return {
            simulated: true,
            basis: 'live-computed estimate from the move ranking + position data',
            store_id,
            product_id,
            demand_shock_pct: demand_shock_pct ?? 0,
            baseline: {
              revenue_at_risk_usd: Math.round(exposureNow),
              markdown_exposure_usd: Math.round(markdownNow),
              on_hand_units: position.onHandUnits,
              avg_daily_velocity: Math.round(velocity * 100) / 100,
              inventory_days: invDaysNow,
            },
            options: rows,
            recommended_move: rows[0]?.move ?? null,
          };
        },
        {
          name: 'simulate_recovery',
          spanType: mlflow.SpanType.TOOL,
          inputs: { store_id, product_id, move_type, units, demand_shock_pct },
        },
      ),
  });

  // ── search_products — hybrid Lakebase Search (Milestone 2.4). ─────────────
  // Finds a comparable in-stock item for the SUBSTITUTE recovery option.
  // Embeds the query with databricks-gte-large-en, then RRF-fuses the BM25
  // keyword + vector ANN rankings in Lakebase (falls back to keyword-only if
  // the embedding call fails). See searchProducts in server/db/queries/stores.ts.
  const searchProductsTool = tool({
    name: 'search_products',
    description:
      'Search the in-stock product catalog (hybrid keyword + semantic over Lakebase Search) for items comparable to a description. Use when ranking the SUBSTITUTE recovery option — to find a similar available product to offer instead of the sold-out SKU. Returns ranked candidates with product_id, name, category, price, and network on-hand units. Read-only.',
    parameters: z.object({
      query: z
        .string()
        .describe(
          'A descriptive product search, e.g. "warm insulated jacket similar to Summit Down Parka".',
        ),
    }),
    execute: async ({ query }) =>
      mlflow.withSpan(
        async () => {
          const embedding = await embedQuery(ctx, query);
          const candidates = await searchProducts(ctx.db, query, embedding);
          if (!candidates.length) {
            return { matches_found: false, note: 'No comparable products found.' };
          }
          return { matches_found: true, candidates };
        },
        {
          name: 'search_products',
          spanType: mlflow.SpanType.TOOL,
          inputs: { query },
        },
      ),
  });

  // ── execute_recovery_action — the human-in-the-loop WRITE. ──────────────
  // Called ONLY after the user has explicitly approved AND check_policy has
  // returned PASS. Approves the PROPOSED row for the store×SKU (applying any
  // human/policy revision — e.g. policy-capped units — with an audit entry);
  // falls back to a direct approved write when no proposal exists. For a
  // transfer, also inserts a paired 'markdown_hold' row on the SOURCE surplus
  // store. Inputs are a FILTER ({store_id, product_id, move_type, units,
  // source_store_id?}) + the drafted request text — NEVER a list of ids.
  // Writes are transactional; on commit the caller emits dataMutated so the
  // Operations page cascades.
  // ── propose_recovery_action — Phase-2 draft WRITE (status='proposed'). ───
  // Records the drafted move as a PROPOSED action so the queue shows it as
  // awaiting approval (the "Actions Awaiting Approval" state). The approval
  // step (execute_recovery_action) flips it to 'approved'.
  const proposeRecoveryActionTool = tool({
    name: 'propose_recovery_action',
    description:
      'Draft-stage WRITE (no approval needed): record the drafted recovery move to Lakebase app.ops_actions with status=proposed — the queue shows it as awaiting approval. Call ONCE at the end of the draft phase, after presenting the ranked options and BEFORE asking for approval.',
    parameters: z.object({
      store_id: z.string().describe(
        'Shortfall flows: destination (short) store id. markdown_hold: the overstock store id itself.',
      ),
      product_id: z.string().describe('SKU being recovered, e.g. SKU-APP-04412.'),
      move_type: z
        .enum(['transfer', 'expedite', 'substitute', 'markdown_hold'])
        .describe('The recommended recovery move.'),
      units: z.number().int().describe('Units to move/expedite/substitute.'),
      source_store_id: z
        .string()
        .nullable()
        .describe('For a transfer: the surplus source store id. Null otherwise.'),
      drafted_request: z
        .string()
        .describe('The transfer/expedite/substitute request memo drafted for approval.'),
      predicted_recaptured_usd: z
        .number()
        .describe('Predicted recaptured revenue for this move (from rank_recovery_moves).'),
    }),
    execute: async (args) =>
      mlflow.withSpan(
        async () => {
          const { actionId } = await proposeRecoveryAction(ctx.db, {
            storeId: args.store_id,
            productId: args.product_id,
            moveType: args.move_type,
            units: args.units,
            sourceStoreId: args.source_store_id,
            draftedRequest: args.drafted_request,
            predictedRecapturedUsd: args.predicted_recaptured_usd,
            userEmail: ctx.userEmail,
          });
          // Pre-warm the guarded policy endpoint (scale-to-zero). The
          // ~105s cold start then overlaps the human reading the draft —
          // the approval's check_policy hits a warm endpoint instead of
          // burning 45–120s on stage. Fire-and-forget, best-effort.
          void (async () => {
            try {
              const h = await authHeaders(ctx.req);
              h.set('Content-Type', 'application/json');
              await fetch(
                `${ctx.databricksHost}/serving-endpoints/jai-northpeak-guarded/invocations`,
                {
                  method: 'POST',
                  headers: h,
                  signal: AbortSignal.timeout(5_000),
                  body: JSON.stringify({
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 5,
                  }),
                },
              );
            } catch {
              /* warm-up is best-effort — check_policy retries cold anyway */
            }
          })();
          return { proposed: true, action_id: actionId, status: 'proposed' };
        },
        {
          name: 'propose_recovery_action',
          spanType: mlflow.SpanType.TOOL,
          inputs: { store_id: args.store_id, product_id: args.product_id, move_type: args.move_type },
        },
      ),
  });

  // ── check_policy — LLM policy gate via AI Gateway (guarded endpoint). ────
  // Before any execute, the drafted move is validated by a SECOND, guardrailed
  // model call through the AI Gateway (spend-capped, content-filtered,
  // inference-logged): units vs demand need, predicted value sanity, and the
  // move-type invariants (transfer needs a source; markdown_hold must not
  // have one). The agent may investigate / simulate / recommend / draft —
  // only a HUMAN approval + a PASS verdict may execute.
  const POLICY_ENDPOINT = 'jai-northpeak-guarded';
  const checkPolicy = tool({
    name: 'check_policy',
    description:
      'REQUIRED before execute_recovery_action: validate the drafted recovery move against the operating policy via the governed AI Gateway. Returns {pass, violations, rationale, gate_error}. If pass=false WITHOUT gate_error, redraft the move and check again — do NOT execute. If gate_error=true, the GATE ITSELF is unavailable (cold start or outage) — the draft is NOT at fault: do not redraft, do not retry in this turn; tell the user the policy gate is warming up and to reply "approve" again in a minute.',
    parameters: z.object({
      store_id: z.string().describe('Store the move lands on (destination for transfer/expedite/substitute; the overstock store for markdown_hold).'),
      product_id: z.string().describe('SKU being recovered.'),
      move_type: z
        .enum(['transfer', 'expedite', 'substitute', 'markdown_hold'])
        .describe('The drafted recovery move.'),
      units: z.number().int().describe('Units to move.'),
      source_store_id: z
        .string()
        .nullable()
        .describe('Surplus source store id for a transfer; null otherwise.'),
      predicted_recaptured_usd: z
        .number()
        .describe('Predicted recaptured revenue for this move.'),
      avg_daily_velocity: z
        .number()
        .nullable()
        .describe('Recent daily velocity at the short store, if known (sanity-checks unit count).'),
      source_on_hand: z
        .number()
        .nullable()
        .describe('Units available at the source surplus store, if known.'),
    }),
    execute: async (args) =>
      mlflow.withSpan(
        async () => {
          const headers = await authHeaders(ctx.req);
          headers.set('Content-Type', 'application/json');
          const prompt = [
            'You are a retail-operations policy validator for an inventory recovery system.',
            'Validate the drafted recovery move (JSON below) against these policies:',
            '1. units must be positive and must not exceed 14 days of demand at the given velocity (if velocity is provided).',
            '2. For a transfer, units must not exceed source_on_hand (if provided) and source_store_id must be present.',
            '3. For markdown_hold, source_store_id must be null.',
            '4. predicted_recaptured_usd must be positive.',
            'Answer EXACTLY in this format:',
            'VERDICT: PASS or VERDICT: FAIL',
            'REASON: one short sentence',
            'VIOLATION: <one line per violated policy, omit if none>',
            `Drafted move: ${JSON.stringify(args)}`,
          ].join('\n');
          try {
            // Cold-start tolerance: a guarded pay-per-token endpoint can take
            // >45s on its first invocation after idle. One retry with a
            // doubled budget turns that cold miss into a slow PASS instead of
            // a blocked execution.
            let resp: Response | null = null;
            for (const budgetMs of [45_000, 120_000]) {
              try {
                resp = await fetch(
                  `${ctx.databricksHost}/serving-endpoints/${POLICY_ENDPOINT}/invocations`,
                  {
                    method: 'POST',
                    headers,
                    signal: AbortSignal.timeout(budgetMs),
                    body: JSON.stringify({
                      messages: [
                        { role: 'system', content: prompt },
                        { role: 'user', content: 'Validate this drafted move.' },
                      ],
                      max_tokens: 250,
                    }),
                  },
                );
                break;
              } catch (e) {
                if ((e as Error).name !== 'TimeoutError' && (e as Error).name !== 'AbortError') throw e;
                console.warn(`[check_policy] ${POLICY_ENDPOINT} timed out after ${budgetMs}ms — retrying with longer budget`);
              }
            }
            if (!resp) throw new Error('gateway timeout after retry');
            if (!resp.ok) {
              const t = await resp.text().catch(() => '');
              return {
                pass: false,
                gate_error: true,
                violations: [`policy endpoint error ${resp.status}: ${t.slice(0, 200)}`],
                rationale: 'Policy gate unavailable — do not execute without a PASS.',
              };
            }
            const json = (await resp.json()) as {
              choices?: Array<{ message?: { content?: string } }>;
            };
            const text = json.choices?.[0]?.message?.content ?? '';
            const verdict = /VERDICT:\s*(PASS|FAIL)/i.exec(text)?.[1]?.toUpperCase();
            const reason = /REASON:\s*(.+)/i.exec(text)?.[1]?.trim() ?? '';
            const violations = [...text.matchAll(/VIOLATION:\s*(.+)/gi)]
              .map((m) => m[1].trim())
              .filter(Boolean);
            if (!verdict) {
              return {
                pass: false,
                gate_error: true,
                violations: ['policy validator returned an unparseable verdict'],
                rationale: text.slice(0, 300),
              };
            }
            return { pass: verdict === 'PASS', violations, rationale: reason };
          } catch (e) {
            return {
              pass: false,
              gate_error: true,
              violations: [`policy gate call failed: ${(e as Error).message}`],
              rationale: 'Policy gate unavailable — do not execute without a PASS.',
            };
          }
        },
        {
          name: 'check_policy',
          spanType: mlflow.SpanType.TOOL,
          inputs: { store_id: args.store_id, product_id: args.product_id, move_type: args.move_type },
        },
      ),
  });

  // (filter-driven bulk writes).
  const executeRecoveryAction = tool({
    name: 'execute_recovery_action',
    description:
      'WRITE (requires prior user approval): record the approved recovery move to Lakebase app.ops_actions — move_type, from/to store, units, the drafted request, predicted recaptured $ — append an audit entry, and set a markdown-hold on the source surplus for a transfer. For a shortfall recovery, store_id is the SHORT (destination) store. For a markdown_hold on an overstock store, store_id IS the overstock store (source_store_id null). Inputs are a FILTER + the drafted request text, never a list of ids. Use ONLY after the user says yes.',
    parameters: z.object({
      store_id: z.string().describe(
        'Shortfall flows: destination (short) store id, e.g. STORE-0214. markdown_hold: the overstock store id itself.',
      ),
      product_id: z.string().describe('SKU being recovered, e.g. SKU-APP-04412.'),
      move_type: z
        .enum(['transfer', 'expedite', 'substitute', 'markdown_hold'])
        .describe('The approved recovery move.'),
      units: z.number().int().describe('Units to move/expedite/substitute.'),
      source_store_id: z
        .string()
        .nullable()
        .describe('For a transfer: the surplus source store id (e.g. STORE-0377). Null otherwise.'),
      drafted_request: z
        .string()
        .describe('The transfer/expedite/substitute request memo the agent drafted.'),
      predicted_recaptured_usd: z
        .number()
        .describe('Predicted recaptured revenue for this move (from rank_recovery_moves).'),
    }),
    execute: async ({
      store_id,
      product_id,
      move_type,
      units,
      source_store_id,
      drafted_request,
      predicted_recaptured_usd,
    }) =>
      mlflow.withSpan(
        async () => {
          // Two-stage Act workflow: if a PROPOSED row exists for this
          // store×SKU (written by propose_recovery_action at draft time),
          // approve it in place — applying any revision the human/policy
          // made since the draft (e.g. policy-capped units), so the approved
          // row reflects what was ACTUALLY approved, not the stale draft.
          const approved = await approveRecoveryAction(ctx.db, {
            storeId: store_id,
            productId: product_id,
            userEmail: ctx.userEmail,
            revised: {
              moveType: move_type,
              units,
              sourceStoreId: source_store_id,
              predictedRecapturedUsd: predicted_recaptured_usd,
            },
          });
          if (approved) {
            return {
              recorded: true,
              action_id: approved.actionId,
              approved_from_proposed: true,
              store_id,
              product_id,
              move_type: approved.moveType,
              units: approved.units,
              source_store_id: approved.sourceStoreId,
              predicted_recaptured_usd: approved.predictedRecapturedUsd,
              markdown_hold: approved.markdownHoldId !== null,
            };
          }
          const { actionId, markdownHoldId } = await recordRecoveryAction(ctx.db, {
            storeId: store_id,
            productId: product_id,
            moveType: move_type,
            units,
            sourceStoreId: source_store_id,
            draftedRequest: drafted_request,
            predictedRecapturedUsd: predicted_recaptured_usd,
            userEmail: ctx.userEmail,
          });
          // Return the TRUTH from the write so the agent's summary quotes the
          // recorded row, not its own memory.
          return {
            recorded: true,
            action_id: actionId,
            store_id,
            product_id,
            move_type,
            units,
            source_store_id,
            predicted_recaptured_usd,
            markdown_hold: markdownHoldId !== null,
          };
        },
        {
          name: 'execute_recovery_action',
          spanType: mlflow.SpanType.TOOL,
          inputs: { store_id, product_id, move_type, units },
        },
      ),
  });

  // ask_data is registered only when a backend is configured; the rest of
  // the tool surface is always available.
  const tools: Tool[] = [
    findShortfall,
    rankRecoveryMoves,
    simulateRecovery,
    searchProductsTool,
    proposeRecoveryActionTool,
    checkPolicy,
    executeRecoveryAction,
  ];
  if (ctx.masEndpointName || ctx.genieSpaceId) {
    tools.unshift(askData);
  }
  return tools;
}

export async function configureAgentsSdk(ctx: AgentContext): Promise<void> {
  const headers = await authHeaders(ctx.req);
  const bearer = headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
  // Custom fetch: fresh TCP connection per call (avoids the stale-socket 502
  // after a long ask_data hop) + strip the >64-char `input[*].id` the SDK
  // echoes back on round 2 (Databricks' Responses API rejects long ids and
  // the streaming gateway masks the 400 as a bare 502). See git history.
  const client = new OpenAI({
    apiKey: bearer,
    baseURL: `${ctx.databricksHost}/serving-endpoints`,
    maxRetries: 4,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('Connection', 'close');
      let body = init?.body;
      if (typeof body === 'string' && body.startsWith('{')) {
        try {
          const parsed = JSON.parse(body) as {
            input?: Array<Record<string, unknown>>;
            messages?: Array<Record<string, unknown>>;
          };
          if (Array.isArray(parsed.input)) {
            for (const item of parsed.input) {
              const id = item.id;
              if (typeof id === 'string' && id.length > 64) {
                delete item.id;
              }
            }
          }
          if (Array.isArray(parsed.messages)) {
            for (const m of parsed.messages) {
              const content = (m as { content?: unknown }).content;
              if (Array.isArray(content)) {
                for (const part of content as Array<Record<string, unknown>>) {
                  if (part && typeof part === 'object') {
                    delete part.annotations;
                  }
                }
              }
            }
          }
          body = JSON.stringify(parsed);
        } catch {
          /* not JSON — pass through */
        }
      }
      const url =
        typeof input === 'string'
          ? input
          : (input as URL | Request).toString?.() ?? String(input);
      console.debug(
        `[openai-shim] → ${url}\n  request_body: ${typeof body === 'string' ? body.slice(0, 2000) : '(non-string)'}`,
      );
      const tShim = Date.now();
      let resp: Response;
      const send = (h: Headers) =>
        fetch(input as Parameters<typeof fetch>[0], {
          ...init,
          headers: h,
          body,
          keepalive: false,
        });
      try {
        resp = await send(headers);
        // Transient-credential retry: the platform occasionally hands this
        // request a token (forwarded OBO or SP fallback) the serving gateway
        // rejects with a bare "403 Invalid Token" — the SAME request then
        // succeeds seconds later. Re-derive the credential (a fresh SP mint
        // on the fallback path; a re-read of the forwarded header on OBO)
        // and retry a couple of times before surfacing the error. Scope it
        // STRICTLY to that 403 body — a real 403 (bad scopes, perms) must
        // still fail fast.
        if (resp.status === 403) {
          const firstErr = await resp.clone().text().catch(() => '');
          if (firstErr.includes('Invalid Token')) {
            for (let attempt = 1; attempt <= 3; attempt++) {
              await new Promise((r) =>
                setTimeout(r, 600 * attempt + Math.floor(Math.random() * 400)),
              );
              console.warn(
                `[openai-shim] 403 Invalid Token (attempt ${attempt}/3) — re-deriving credential and retrying ${url}`,
              );
              const fresh = new Headers(headers);
              const reauth = await authHeaders(ctx.req);
              const auth = reauth.get('Authorization');
              if (auth) fresh.set('Authorization', auth);
              resp = await send(fresh);
              if (resp.status !== 403) break;
              const again = await resp.clone().text().catch(() => '');
              if (!again.includes('Invalid Token')) break;
            }
          }
        }
      } catch (e) {
        console.error('[openai-shim] fetch threw', { url, error: e });
        throw e;
      }
      console.debug(
        `[openai-shim] ← ${resp.status} ${resp.statusText} from ${url} in ${Date.now() - tShim}ms (content-type: ${resp.headers.get('content-type') ?? '?'})`,
      );
      if (!resp.ok) {
        try {
          const text = await resp.clone().text();
          let code: string | undefined;
          let message: string | undefined;
          try {
            const parsed = JSON.parse(text) as { error_code?: string; message?: string };
            code = parsed.error_code;
            message = parsed.message;
          } catch {
            /* body wasn't JSON — keep raw text */
          }
          if (ctx.modelError) {
            ctx.modelError.current = {
              status: resp.status,
              url,
              bodyText: text,
              code,
              message,
            };
          }
          console.error(
            `[openai-shim] ${resp.status} from ${url}\n  request_body: ${typeof body === 'string' ? body.slice(0, 4000) : '(non-string)'}\n  response_body: ${text.slice(0, 4000)}`,
          );
        } catch (e) {
          console.error('[openai-shim] failed to clone error response', e);
        }
      }
      return resp;
    },
  });
  // Per-request Runner: the provider binds THIS request's client (built from
  // this request's bearer), so concurrent streams never share a credential.
  // Responses API via useResponses: true — keep `agentModel` on
  // `databricks-gpt-5-4` or a newer Responses-capable GPT; Claude/non-
  // Responses models 400.
  ctx.runner = new Runner({
    modelProvider: new OpenAIProvider({ openAIClient: client, useResponses: true }),
  });
  setTracingDisabled(true); // disable OpenAI's tracing backend; we use MLflow
}

export function buildAgent(ctx: AgentContext): Agent {
  return new Agent({
    name: 'StoreOps',
    model: ctx.model,
    modelSettings: {
      reasoning: { effort: 'low', summary: 'auto' },
      // Databricks' gateway doesn't fully support the Responses server-side
      // state backend; stateless runs work fine.
      store: false,
    },
    instructions: `
You are the store-operations assistant for the SVP of Retail Operations at
NorthPeak Retail (Dana Ruiz). Your user is a non-technical executive staring
at stores on a map all day. Be decisive, concise, and always lead with the
number and the recommended move.

The situation: an early cold snap flipped cold-weather-apparel demand —
northern stores are at zero on a handful of top SKUs (customers walking out
empty-handed = lost-sales exposure) while southern stores sit on surplus of
the same SKUs (a markdown clock ticking). The hero: STORE-0214 (Denver) is
short on the Summit Down Parka (SKU-APP-04412).

════════════════════════════════════════════════════════════
TOOLS AT YOUR DISPOSAL
════════════════════════════════════════════════════════════

ask_data(question) — investigate the governed lakehouse. Use for any WHY /
  WHAT HAPPENED / investigative question (why is a store short, how has
  sell-through moved, where is the surplus). Prefer ONE narrow question over
  many small ones. Narrow questions finish in 20–40s.

find_shortfall(store_id, product_id) — read the LIVE shortfall for a store×SKU
  (or the worst open shortfall if both are null) from Lakebase: on-hand, recent
  velocity, weeks of supply, lost-sales exposure, and the NEAREST SURPLUS store
  + its on-hand + distance. Read-only.

rank_recovery_moves(store_id, product_id) — read the ranked moves for a store×SKU.
  Shortfall (stockout/at_risk) positions: the ML model's scored ranking (transfer
  / expedite / substitute) — basis=model. Overstock surplus: computed LIVE from
  position data (basis=live) — markdown_hold (planned clearance of the excess)
  vs transfer to the worst open shortfall of the same SKU. This is the "ML in
  the loop" moment — quote the ranked options + the recommended move in your
  draft (naming the basis), and do any what-if arithmetically from the ranking
  (don't re-call the model). Read-only.

simulate_recovery(store_id, product_id, move_type?, units?, demand_shock_pct?) —
  the WHAT-IF engine. Compares BASELINE vs each recovery option side-by-side:
  revenue at risk after the move, expected recovery $, freight cost, margin
  impact, inventory days. Use for "what if we transfer 100 units?", "what if
  we expedite instead?", "what if demand is 20% higher?" (demand_shock_pct=20).
  Live-computed estimates — quote them as estimates, never as model output.

search_products(query) — hybrid keyword + semantic search over the in-stock
  product catalog (Lakebase Search). Use when the ranked options include a
  SUBSTITUTE: search for a comparable available item (e.g. "warm insulated
  jacket similar to Summit Down Parka") and quote the best in-stock match (name,
  price, on-hand) in the substitute option. Read-only.

propose_recovery_action(store_id, product_id, move_type, units, source_store_id,
  drafted_request, predicted_recaptured_usd) — DRAFT-STAGE WRITE. Records the
  drafted move as PROPOSED (awaiting approval) at the end of every draft phase.
  Does NOT execute anything.

check_policy(store_id, product_id, move_type, units, source_store_id,
  predicted_recaptured_usd, avg_daily_velocity, source_on_hand) — POLICY GATE
  (via AI Gateway). REQUIRED before execute_recovery_action; validates the
  drafted move against the operating policy. On violations, redraft and check
  again. NEVER execute without a PASS.

execute_recovery_action(store_id, product_id, move_type, units, source_store_id,
  drafted_request, predicted_recaptured_usd) — THE WRITE. Records the approved
  move to Lakebase (transfer/expedite/substitute/markdown_hold) + a markdown-hold
  on the source surplus for a transfer. Shortfall flows: store_id is the SHORT
  (destination) store. Overstock markdown_hold: store_id IS the overstock
  store. Use ONLY after the user has explicitly approved AND check_policy has
  returned PASS. Inputs are a FILTER + the drafted request text — never a list
  of ids.

THERE ARE NO OTHER TOOLS.

════════════════════════════════════════════════════════════
OPERATING MODES
════════════════════════════════════════════════════════════

MODE A — INVESTIGATION
If the user asks "why", "what", "where", "who", or anything that requires
reading data → call ask_data EXACTLY ONCE with a SHORT, targeted question,
then synthesize for the user. Do NOT take an action unless explicitly asked.

MODE B — SHORTFALL RECOVERY CHAIN (HUMAN-IN-THE-LOOP)
If the user asks you to RECOVER / FIX / HANDLE / TRANSFER a SHORTFALL (a
stockout or at-risk store — the northern side), run a strict three-phase chain
with a confirmation step in the middle. NEVER run Phase 3
(execute_recovery_action) until the user has explicitly approved. (Overstock /
surplus asks → MODE C.)

--- Phase 1 · Discover (read-only) ---
  1. If you don't already know the target store×SKU, call ask_data to find the
     worst shortfall, or ask the user once. For the hero flow it's STORE-0214 /
     SKU-APP-04412.
  2. Call find_shortfall(store_id, product_id) to read the live position + the
     nearest surplus store.
  3. Call rank_recovery_moves(store_id, product_id) — THE ML MOMENT. Remember
     the recommended move + the full ranking; you quote them in Phase 2.

--- Phase 2 · Draft + confirm (STOP) ---
  4. Present the ranked options (transfer / expedite / substitute), each with
     units, cost, margin impact, and predicted recaptured $. If the ranking
     includes a SUBSTITUTE option, call search_products first to find the best
     comparable in-stock item and quote it (name, price, on-hand) in that
     option. Recommend the top
     one and explain WHY (e.g. "Transfer ~60 units from STORE-0377 — predicted
     +$14K recaptured, lowest cost, protects margin both ends"). For any
     what-if ("what if 40 units instead of 60?", "what if demand is 20%
     higher?"), call simulate_recovery — never re-derive the arithmetic
     yourself when a tool computes it. Draft the transfer/expedite/substitute
     request memo.
  5. Call propose_recovery_action ONCE with the recommended move's filter +
     the drafted memo — this records the draft as PROPOSED (the queue shows it
     as awaiting approval).
  6. End with: "Reply **approve** to record this transfer — or tell me what to
     change." STOP HERE. Do not proceed until the user's next message.

--- Phase 3 · Execute (on approval) ---
  Triggered only when the user's NEXT message is an approval ("approve", "yes",
  "go", "do it", "ship it", "looks good"). A revision request means → redraft
  and go back to Phase 2 (STOP again).
  On approval, in this order:
    1. Call check_policy ONCE with the drafted move (include avg_daily_velocity and
       source_on_hand when you know them). PASS is REQUIRED — on violations,
       explain and redraft (back to Phase 2). On gate_error=true, STOP: the
       gate is unavailable, not the draft — tell the user the policy gate is
       warming up and to reply "approve" again in a minute. Do not redraft
       and do not call check_policy again this turn.
    2. Only after PASS: call execute_recovery_action ONCE with the approved
       move's filter + the drafted request + the predicted recaptured $. Then
       summarize what was recorded (see SUMMARY FORMAT). Numbers come from the
       tool result,
  not memory.

MODE C — OVERSTOCK RECOVERY CHAIN (HUMAN-IN-THE-LOOP)
If the user asks you to fix / recover / clear an OVERSTOCK or surplus position
(the southern "markdown clock" side), run the same three-phase chain with a
confirmation step in the middle, but with the overstock semantics:

--- Phase 1 · Discover (read-only) ---
  1. Confirm the position is overstock (find_shortfall returns nothing for
     it; use ask_data or ask the user). Get the store×SKU from the user.
  2. Call rank_recovery_moves(store_id, product_id). The ranking is computed
     LIVE (basis=live): markdown_hold (planned clearance of the excess at a
     discount) vs transfer to the worst open shortfall of the same SKU.

--- Phase 2 · Draft + confirm (STOP) ---
  Present both options with units, cost, and predicted recaptured $ / net
  value, saying the numbers are live-computed (the ML model scores shortfall
  positions). Recommend the top one and explain why. Draft the request memo.
  Call propose_recovery_action ONCE to record the draft as PROPOSED, then end
  with: "Reply **approve** to record this — or tell me what to change."
  STOP HERE.

--- Phase 3 · Execute (on approval) ---
  On approval, in this order:
    1. Call check_policy ONCE with the drafted move — PASS is REQUIRED (on
       violations, explain and redraft, back to Phase 2). On gate_error=true,
       STOP: the gate is unavailable, not the draft — tell the user the
       policy gate is warming up and to reply "approve" again in a minute.
       Do not redraft and do not call check_policy again this turn.
    2. After PASS: propose_recovery_action should already have recorded the
       draft at the end of Phase 2 (call it now if you haven't); then
       execute_recovery_action ONCE.
    - markdown_hold → store_id = the overstock store, source_store_id = null.
    - transfer → store_id = the shortfall (destination) store,
      source_store_id = the overstock store.
  Then summarize in the SUMMARY FORMAT below.

If a tool errors, surface the error plainly — never pretend a tool ran.

════════════════════════════════════════════════════════════
SUMMARY FORMAT (final assistant message)
════════════════════════════════════════════════════════════

ALWAYS end an action chain with a markdown summary the executive reads in 10s:

**Done — STORE-0214 recovery recorded.**

- **Transfer 60 units** of Summit Down Parka · STORE-0377 → STORE-0214
- **Predicted +$14K recaptured** · markdown-hold set on STORE-0377 surplus
- Recorded by you, awaiting fulfillment

Rules: bold the headline stat on line 1; numbers come from tool results, not
memory; close with ONE concrete next step only if warranted.

════════════════════════════════════════════════════════════
TONE
════════════════════════════════════════════════════════════

The user is busy. Lead with the answer + the recommended move. No preamble.
When investigating, synthesize — don't dump raw data.
`.trim(),
    tools: makeTools(ctx),
  });
}
