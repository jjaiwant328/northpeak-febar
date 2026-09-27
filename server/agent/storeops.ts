/**
 * The store-ops action-taking agent — the DEMO'S DEFINING PIECE, and the
 * WORKSHOP'S main graded surface.
 *
 * Built on `@openai/agents` (OpenAI Agents SDK) pointed at Databricks'
 * Responses API. Tools capture `db` + `userEmail` via closure so every
 * action is attributed to the viewing user (OBO).
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHAT SHIPS WORKING vs WHAT THE TRAINEE BUILDS  (see APP_WORKSHOP.md)
 * ════════════════════════════════════════════════════════════════════════
 * SHIPS WORKING:
 *   - The full agent loop (Responses API wiring, streaming, MLflow spans).
 *   - `ask_data` — the investigation tool. Config-driven MAS-OR-Genie:
 *     uses the MAS endpoint if `masEndpointName` is set, else the Genie
 *     space if `genieSpaceId` is set. This is the trainee's Build-1 choice
 *     (they wire ONE backend); the app registers whichever is configured.
 *
 * TRAINEE BUILDS (stubbed here — they THROW "not implemented" so the app
 * still compiles + boots, and the model knows the tools exist):
 *   - `find_shortfall`         → Build 2 (Assist): read the live shortfall
 *   - `rank_recovery_moves`    → Build 2 (Assist): read the ML recommendation
 *   - `execute_recovery_action`→ Build 3 (Act):   the human-in-the-loop write
 *
 * The three-phase chain (Discover → Draft+confirm → Execute) is described in
 * the instructions below so the model attempts it — but Phases 2/3 depend on
 * the stubbed tools, which is the point: the trainee implements them and the
 * chain lights up. Until then, the model can still investigate via ask_data.
 *
 * KEEP `configureAgentsSdk()` as-is — it handles the Databricks Responses API
 * wiring, the `Connection: close` stale-socket workaround, and the 64-char
 * `input[*].id` strip.
 */
import type { Request } from 'express';
import OpenAI from 'openai';
import {
  Agent,
  run,
  setDefaultOpenAIClient,
  setTracingDisabled,
} from '@openai/agents';
import type { Tool } from '@openai/agents';
import { loggedTool as tool } from './tools/logged-tool.js';
import * as mlflow from 'mlflow-tracing';
import { z } from 'zod';
import { authHeaders } from '../lib/auth.js';
import type { AppDb } from '../db/index.js';
// Ready-made Lakebase query + write helpers (Build 2 / Build 3). find_shortfall
// + rank_recovery_moves read the synced mirrors; execute_recovery_action writes
// via recordRecoveryAction. See server/db/queries/stores.ts + APP_WORKSHOP.md.
import {
  getShortfall,
  worstShortfall,
  getPosition,
  getRecommendation,
  recordRecoveryAction,
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
// preserves the template's MAS-OR-Genie flexibility exactly.
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
   * empty to use Genie instead. This is the trainee's Build-1 backend choice
   * — the app registers whichever of MAS/Genie is configured. */
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
  // ── ask_data — SHIPS WORKING. Config-driven MAS-OR-Genie. ─────────────────
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

  // ── find_shortfall — TRAINEE BUILDS (Build 2 · Assist). STUB. ─────────────
  // TODO — BUILD 2 (trainee): implement this. Read the open shortfall for
  // {store_id, product_id} (or the worst one) from Lakebase app.open_shortfalls
  // + app.store_sku_position: on_hand, recent velocity, weeks_of_supply,
  // lost-sales exposure, AND the nearest surplus store + its on-hand + distance.
  // Helper queries are READY in server/db/queries/stores.ts: `getShortfall`,
  // `worstShortfall`, `getPosition`. See APP_WORKSHOP.md → "Layer 2 — Assist".
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

  // ── rank_recovery_moves — TRAINEE BUILDS (Build 2 · Assist). STUB. ────────
  // TODO — BUILD 2 (trainee): implement this. Read app.recovery_recommendations
  // for {store_id, product_id} and return the model's recommended_move,
  // predicted_recaptured_usd, predicted_net_value_usd, and the full move_ranking
  // (all three options with predicted recaptured $ + net $ + cost). This is the
  // demo's "ML in the loop" moment — the agent quotes the ranked options + the
  // recommended move in the draft, and recomputes the what-if arithmetically
  // from move_ranking. Helper query READY: `getRecommendation` in stores.ts.
  // See APP_WORKSHOP.md → "Layer 2 — Assist".
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

  // ── execute_recovery_action — TRAINEE BUILDS (Build 3 · Act). STUB. ───────
  // TODO — BUILD 3 (trainee): implement this — the human-in-the-loop WRITE.
  // ONLY call this AFTER the user has explicitly approved. Write the approved
  // move to Lakebase app.ops_actions (move_type, from/to store, units, the
  // drafted request text, predicted recaptured $, status='approved',
  // approved_by=ctx.userEmail, an appended audit entry). For a transfer, also
  // insert a paired 'markdown_hold' row on the SOURCE surplus store. Inputs are
  // a FILTER ({store_id, product_id, move_type, units, source_store_id?}) + the
  // drafted request text — NEVER a list of ids. Wrap the write(s) in
  // db.transaction(...). On commit the caller emits dataMutated so the
  // Operations page cascades. See APP_WORKSHOP.md → "Layer 3 — Act"
  // (+ TEMPLATE_MAP pattern #5, filter-driven bulk writes).
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

  // find_shortfall / rank_recovery_moves / execute_recovery_action are
  // registered so the MODEL knows they exist (and the trainee sees them in
  // the tool list) — they throw until implemented. ask_data is registered
  // only when a backend is configured.
  const tools: Tool[] = [
    findShortfall,
    rankRecoveryMoves,
    searchProductsTool,
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
            for (let attempt = 1; attempt <= 2; attempt++) {
              await new Promise((r) => setTimeout(r, 750 * attempt));
              console.warn(
                `[openai-shim] 403 Invalid Token (attempt ${attempt}/2) — re-deriving credential and retrying ${url}`,
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
  setDefaultOpenAIClient(client);
  // Responses API (the SDK's default — we leave setOpenAIAPI alone).
  // Keep `agentModel` on `databricks-gpt-5-4` or a newer Responses-capable
  // GPT (needs `openai/v1/responses`). Claude/non-Responses models 400.
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

search_products(query) — hybrid keyword + semantic search over the in-stock
  product catalog (Lakebase Search). Use when the ranked options include a
  SUBSTITUTE: search for a comparable available item (e.g. "warm insulated
  jacket similar to Summit Down Parka") and quote the best in-stock match (name,
  price, on-hand) in the substitute option. Read-only.

execute_recovery_action(store_id, product_id, move_type, units, source_store_id,
  drafted_request, predicted_recaptured_usd) — THE WRITE. Records the approved
  move to Lakebase (transfer/expedite/substitute/markdown_hold) + a markdown-hold
  on the source surplus for a transfer. Shortfall flows: store_id is the SHORT
  (destination) store. Overstock markdown_hold: store_id IS the overstock
  store. Use ONLY after the user has explicitly approved. Inputs are a FILTER +
  the drafted request text — never a list of ids.

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
     +$14K recaptured, lowest cost, protects margin both ends"). Offer a what-if
     ("what if 40 units instead of 60?") computed arithmetically from the
     ranking. Draft the transfer/expedite/substitute request memo.
  5. End with: "Reply **approve** to record this transfer — or tell me what to
     change." STOP HERE. Do not proceed until the user's next message.

--- Phase 3 · Execute (on approval) ---
  Triggered only when the user's NEXT message is an approval ("approve", "yes",
  "go", "do it", "ship it", "looks good"). A revision request means → redraft
  and go back to Phase 2 (STOP again).
  On approval: call execute_recovery_action ONCE with the approved move's
  filter + the drafted request + the predicted recaptured $. Then summarize
  what was recorded (see SUMMARY FORMAT). Numbers come from the tool result,
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
  End with: "Reply **approve** to record this — or tell me what to change."
  STOP HERE.

--- Phase 3 · Execute (on approval) ---
  On approval: execute_recovery_action ONCE.
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

export { run };
