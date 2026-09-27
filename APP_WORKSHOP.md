# NorthPeak Store Ops — Workshop Build Guide (for an AI coding agent)

> **Read this if you are an AI agent (Genie Code / Claude Code) implementing the graded gaps.**
> This app is a **bootstrap**, not a finished demo. It boots and ships three things working:
> **(1)** the plumbing (routing, OBO auth, MLflow tracing, SSE streaming, chat dock),
> **(2) Layer 1 — Visualize** (the store-shortfall map + queue reading Lakebase),
> **(3)** the agent loop with a working `ask_data` tool (Genie/MAS investigation).
> You (the trainee, with an agent) build the rest: **Layer 2 — Assist**, **Layer 3 — Act**, and **Build 3 — Unity AI Gateway**. Each section below tells you EXACTLY what ships vs what you build, the exact file paths + signatures + Lakebase tables/columns, the acceptance check, and a prompt you can paste to an agent to do it.

---

## The story (one paragraph)

An early cold snap flipped cold-weather-apparel demand. ~30 northern stores are at **zero** on the same 5 SKUs (customers walking out empty-handed = **lost-sales exposure**) while ~40 southern stores sit on **surplus** of those SKUs (a **markdown clock** ticking). The hero: **STORE-0214 (Denver)** is short on the **Summit Down Parka (SKU-APP-04412)**; the recommended fix is a transfer from **STORE-0377 (Colorado Springs, ~100 mi)**. The 5 affected SKUs: `SKU-APP-04412 / 04418 / 04431 / 04455 / 04460`. The whole app answers one hero question: **"Store 214 is short on a top product — what's the best recovery move?"**

The three layers map 1:1 to the enablement build arc: **Visualize (Build-2 Apps)** → **Assist (Build-2 Apps + the ML step)** → **Act (Build-2 Apps)**, all governed by **Unity AI Gateway (Build 3)**.

---

## The data (already generated + validated in `ai_demo_gen.northpeak_retail`)

The app mirrors these Gold tables into Lakebase Postgres (`app.*`) at boot (see `server/db/sync.ts`). **In Lakebase the synced mirrors are READ-ONLY; the app writes ONLY `app.ops_actions`.**

| Lakebase table (`app.*`) | Source Delta table | Read-only? | Key columns |
|---|---|---|---|
| `store_sku_position` | `gold_store_sku_position` | yes (synced) | `id`(=`store_id:product_id`), `store_id`, `store_name`, `region`, `climate_zone`, `city`, `store_lat`, `store_lng`, `product_id`, `product_name`, `on_hand_units`, `avg_daily_velocity`, `weeks_of_supply`, `price_usd`, `markdown_risk_score`, `lost_sales_exposure_usd`, `markdown_exposure_usd`, `position_status` (`stockout`/`at_risk`/`overstock`/`healthy`) |
| `open_shortfalls` | `gold_open_shortfalls` | yes (synced) | `store_id`, `product_id`, `on_hand_units`, `avg_daily_velocity`, `lost_sales_exposure_usd`, `nearest_surplus_store_id`, `nearest_surplus_on_hand`, `nearest_surplus_distance_km` |
| `recovery_recommendations` | `gold_recovery_recommendations` | yes (synced) | `store_id`, `product_id`, `recommended_move`, `recommended_source_store_id`, `recommended_units`, `predicted_recaptured_usd`, `predicted_net_value_usd`, `move_ranking` (JSONB: all three options) |
| **`ops_actions`** | — (the app's own) | **NO — writable** | `id`(uuid), `store_id`, `product_id`, `move_type`, `source_store_id`, `units`, `drafted_request`, `predicted_recaptured_usd`, `status`, `approved_by`, `audit_trail`(jsonb), `created_at`, `decided_at` |

> **`gold_recovery_recommendations` is NOT built yet.** It is produced by the ML step of Build 2 (`specifications/03-ml-recovery.md`). The app tolerates it being absent — `server/db/sync.ts` catches `TABLE_OR_VIEW_NOT_FOUND` and leaves that mirror empty, so the app boots and the Visualize layer works. **Once you build + score the model into `gold_recovery_recommendations`, restart the app (or hit the Reset-demo button) and the mirror fills.** Then `rank_recovery_moves` (below) returns real data.

The Drizzle schema for all of the above is in `server/db/schema.ts`; ready-made query helpers are in `server/db/queries/stores.ts`.

---

## Where the code you edit lives

| Concern | File |
|---|---|
| The agent + its tools | `server/agent/storeops.ts` |
| Lakebase query helpers (read + write) | `server/db/queries/stores.ts` |
| The data-backend `ask_data` tool | already wired in `storeops.ts` (delegates to `server/agent/tools/mas.ts` OR `tools/genie.ts`) |
| The write-refresh cascade (client) | `client/src/lib/events.ts` (`dataMutated`), consumed by `client/src/operations/OperationsView.tsx` |
| Model endpoint / Gateway config | `config/app.json` (`agentModel`) + `app.yaml` (`user_authorization.scopes`) |

**Tool-authoring rules (READ before editing `parameters: z.object(...)` in `storeops.ts`):** the Agents SDK ships each tool schema to the Responses API with `strict: true` — every field must be in `required`, so use `.nullable()`, NEVER `.optional()`. Every field needs `.describe(...)`. Property names stay `snake_case`. Use the `loggedTool` wrapper (imported as `tool`), not the raw SDK `tool`.

---

## Build 1 (Lakebase) — already wired for you

The synced mirrors + the writable `ops_actions` table are the Build-1 answer key, already modeled in `server/db/schema.ts` and synced in `server/db/sync.ts`. Your Build-1 workshop task in the workspace is to set up the **real Lakebase Synced Tables** for the three Gold tables and pick your **`ask_data` backend** (a Genie space OR a MAS endpoint):

- Set **ONE** of `GENIE_SPACE_ID` / `MAS_ENDPOINT_NAME` in `.env` (or the DAB). The app registers whichever is set as the `ask_data` tool — no code change needed. The default NorthPeak flow uses **Genie** ("ask why Store 214 is short").

**Acceptance:** open the app → chat → ask *"Where are we short and where are we over-stocked?"* → the Thinking panel shows the `ask_data` investigation and you get a synthesized answer.

---

## Layer 2 — Assist (Build 2): `find_shortfall` + `rank_recovery_moves`

**What SHIPS working:** the full agent loop, `ask_data`, and the three-phase instructions in `server/agent/storeops.ts` that TELL the model to call these tools. Both tools are **registered** (so the model + tool list know they exist) but **throw `"Not implemented"`** until you implement them.

**What YOU build:** replace the two stub `execute` bodies in `server/agent/storeops.ts`. The Lakebase query helpers are already written in `server/db/queries/stores.ts` — you mostly wire them up.

### 2a. `find_shortfall`

Read the live shortfall for a store×SKU (or the worst open one) + its nearest surplus.

- **File:** `server/agent/storeops.ts`, the tool named `find_shortfall` (search for `TODO — BUILD 2`).
- **Signature (already declared):** `find_shortfall({ store_id: string | null, product_id: string | null })`. Both null → return the worst open shortfall.
- **Lakebase helpers to use** (from `server/db/queries/stores.ts`, imported at the top of `storeops.ts`):
  - `getShortfall(ctx.db, storeId, productId)` → `Shortfall | null` — reads `app.open_shortfalls`.
  - `worstShortfall(ctx.db)` → `Shortfall | null` — the worst open shortfall by `lost_sales_exposure_usd`.
  - `getPosition(ctx.db, \`${storeId}:${productId}\`)` → `PositionRow | null` — the live position (on-hand, velocity, weeks of supply, exposure).
- **Expected tool output shape** (an object the model reads):
  ```
  {
    store_id, product_id, store_name, city,
    on_hand_units, avg_daily_velocity, weeks_of_supply, lost_sales_exposure_usd,
    nearest_surplus_store_id, nearest_surplus_on_hand, nearest_surplus_distance_km
  }
  ```
  Combine the `Shortfall` fields with the `PositionRow` fields (`store_name`, `city`, `weeks_of_supply`). If nothing is found, return `{ found: false }` (do not throw). Wrap the body in `mlflow.withSpan(async () => {...}, { name: 'find_shortfall', spanType: mlflow.SpanType.TOOL, inputs: {...} })` like `ask_data` does.

### 2b. `rank_recovery_moves`

Read the ML model's ranked moves — **the demo's "ML in the loop" moment.**

- **File:** `server/agent/storeops.ts`, the tool named `rank_recovery_moves`.
- **Signature (already declared):** `rank_recovery_moves({ store_id: string, product_id: string })`.
- **Lakebase helper to use:** `getRecommendation(ctx.db, storeId, productId)` → `RecoveryRecommendation | null` — reads `app.recovery_recommendations` (mirrored from `gold_recovery_recommendations`).
- **Expected tool output shape:**
  ```
  {
    store_id, product_id,
    recommended_move,               // 'transfer' | 'expedite' | 'substitute'
    recommended_source_store_id,    // e.g. STORE-0377 for a transfer
    recommended_units,
    predicted_recaptured_usd,
    predicted_net_value_usd,
    move_ranking: [                 // ALL three options — quote these in the draft
      { move, units, costUsd, predictedRecapturedUsd, predictedNetValueUsd, sourceStoreId?, substituteProductId? },
      ...
    ]
  }
  ```
  Return `getRecommendation(...)` directly (its shape already matches). If it returns `null`, return `{ scored: false, note: 'No recovery recommendation yet — build + score the recovery_recommender model (Build 2 ML step), then reset the demo.' }` so the agent can explain the gap instead of throwing. Wrap in `mlflow.withSpan`.

**Also add the "explain / what-if / draft" behavior:** the instructions in `storeops.ts` already steer the model to quote the ranked options, recommend the top move + explain *why*, offer an arithmetic what-if from `move_ranking`, and draft the transfer memo — once these two tools return data, that behavior lights up. No extra code needed beyond the two tool bodies.

**Acceptance (2a + 2b):** after building + scoring the model and restarting, chat:
1. *"Why is Store 214 out of the Summit Down Parka, and what are my options?"* → `ask_data` investigates + `find_shortfall` returns the live position + nearest surplus (STORE-0377).
2. *"Rank the recovery move. Use the model."* → `rank_recovery_moves` returns the ranking; the agent quotes **transfer / expedite / substitute** each with predicted recaptured $, recommends transfer, drafts the memo, and **STOPS for approval**.
   Both tool calls appear in the Thinking panel and the MLflow trace.

**Paste-to-agent prompt for Layer 2 (2a + 2b):**
> In `server/agent/storeops.ts`, implement the `find_shortfall` and `rank_recovery_moves` tools (they currently throw "Not implemented"). Use the ready-made helpers from `server/db/queries/stores.ts`: `getShortfall`, `worstShortfall`, `getPosition` for `find_shortfall`; `getRecommendation` for `rank_recovery_moves`. Match the output shapes documented in `APP_WORKSHOP.md` §Layer 2. Wrap each body in `mlflow.withSpan(...)` like the `ask_data` tool. Return a `{found:false}` / `{scored:false}` object instead of throwing when the row is missing. Keep the zod schemas exactly as declared (`.nullable()`, not `.optional()`).

### 2c. `search_products` — Product search via Lakebase Search

**What SHIPS working:** the tool is registered + the agent instructions steer the model to call it when ranking the **substitute** recovery option, but the body throws `"Not implemented"` until you implement it.

**What YOU build:** the `search_products` tool body + a Lakebase query helper to perform **hybrid text/vector search** over the product catalog indexed in Lakebase Postgres (Milestone 2 Lakebase work).

#### 2c-i. The query helper (add to `server/db/queries/stores.ts`)

Add `searchProducts(db, query)` that executes a hybrid search over the `products` table using **Lakebase Search**:

- **Signature:**
  ```ts
  searchProducts(db: AppDb, query: string): Promise<Array<{
    product_id: string;
    product_name: string;
    category: string;
    price_usd: number;
    on_hand_units: number;
  }>>
  ```
- **What it does:** Lakebase Search is a Milestone-2 capability (set up during Build 1 Lakebase provisioning — see `03_DATA_MODEL.md` notes on the `products` table having `Lakebase Search` enabled over name + description fields). Issue a **hybrid full-text + vector search** query over `app.products` matching on (name, description) and return the top 5–10 ranked candidates sorted by relevance. Each result carries product_id, product_name, category, price_usd, and a joined `on_hand_units` from the latest `store_sku_position` snapshot (or a default if no position exists for that product yet).
- **Example behavior:** search query `"warm insulated jacket"` → returns the **Ridgeline Insulated Jacket** (SKU-APP-04418) and **Timberline Fleece Hoodie** (SKU-APP-04431) as top matches (the `description` field has "insulated" + "warm layer" text for these products).
- **SQL pattern** — Lakebase Postgres supports full-text search via `tsquery` or `websearch_to_tsquery`, and (if a vector embedding extension is provisioned) vector similarity. Write the query to match your Lakebase provisioning. At minimum, use a **full-text search** over product_name + description (fast, no ML deps). If vectors are indexed, add a vector similarity clause with `.similarity()` for hybrid ranking.

#### 2c-ii. The tool body (in `server/agent/storeops.ts`)

Add a new tool `search_products` or replace the stub (search `TODO — BUILD 2 PRODUCT SEARCH`):

- **Signature (already declared or to be added):** `search_products({ query: string })`.
- Call `searchProducts(ctx.db, query)` (from the helper above). Wrap in `mlflow.withSpan(..., { name: 'search_products', spanType: mlflow.SpanType.TOOL })`.
- **Return:**
  ```ts
  {
    matches_found: true,
    candidates: [
      { product_id, product_name, category, price_usd, on_hand_units },
      ...
    ]
  }
  ```
  If no matches, return `{ matches_found: false, note: 'No comparable products found.' }`.
- **Integration with substitute ranking:** the agent instructions already tell the model: when the ranked options include **substitute**, call `search_products` with a descriptive query (e.g., *"warm insulated jacket similar to Summit Down Parka"*) to find the best candidate from in-stock inventory. The tool returns the top candidates; the agent picks the best match and quotes it in the draft.

#### 2c-iii. UI affordance (lightweight add to Operations detail drawer)

In the detail drawer's **Shortfall tab**, under the ranked recovery options, add a small **product search box** for the substitute option:
- **Label:** "Find a substitute"
- **Input:** free-text search box
- **Button:** "Search" (or auto-search on input if low-latency)
- **Results:** a dropdown or small panel showing top 5 matches (product name, category, price, on-hand)
- **Action:** clicking a result updates the substitute option's text to show the selected product

This UI lets a user manually search too, and serves as a demo of Lakebase Search. (The agent calls the tool automatically during ranking; this UI is for manual exploration.)

**Acceptance (2c):** after configuring Lakebase Search on the `products` table (Milestone 2 work) and implementing the helper + tool:
1. Run the full script: *"What's the best recovery move for Store 214?"* → investigate → rank.
2. In `rank_recovery_moves` output, for the **substitute** option, the agent calls `search_products` with a query like *"warm insulated jacket similar to Summit Down Parka"*.
3. `search_products` returns the **Ridgeline Insulated Jacket** + **Timberline Fleece Hoodie** as top matches (on-hand inventory available).
4. Agent quotes: **"Substitute the Ridgeline Insulated Jacket (in stock: 245 units, $189, similar warmth): +$6K recaptured, leaks margin."**
5. The Thinking panel shows the `search_products` tool call + results.
6. (Optional) The Operations detail drawer's substitute option shows a product search box you can query manually.

**Paste-to-agent prompt for Layer 2c:**
> Add product search via Lakebase Search (Milestone 2) to power the **substitute** recovery move. (1) In `server/db/queries/stores.ts` add `searchProducts(db, query)` — perform hybrid full-text + vector search over `app.products` (name + description indexed by Lakebase Search) returning top 5–10 matches with product_id, product_name, category, price_usd, on_hand_units. (2) In `server/agent/storeops.ts` add/implement the `search_products` tool to call this helper with the input query (e.g., "warm insulated jacket"). Return `{matches_found, candidates[]}` or `{matches_found: false}`. The agent instructions already steer the model to call this when ranking the substitute option; test with the query "warm insulated jacket similar to Summit Down Parka" → expect Ridgeline + Timberline as candidates. (3) Optional: add a lightweight product search box in the Operations detail drawer's substitute option so users can manually search too. Verify the tool call appears in the Thinking panel during the full demo flow.

---

## Layer 3 — Act (Build 2): `execute_recovery_action`

The human-in-the-loop **write** — the moment the demo lands.

**What SHIPS working:** the tool is registered + the Phase-3 instructions steer the model to call it only after approval; the client Operations page + drawer already subscribe to `dataMutated` and will refetch when a write lands. **What YOU build:** the write body + a new Lakebase write helper.

### 3a. The write helper (add to `server/db/queries/stores.ts`)

Add `recordRecoveryAction(db, args)` following the **filter-driven, transactional** pattern (see `TEMPLATE_MAP.md` pattern #5 — inputs are a FILTER + drafted text, never a list of ids; wrap in `db.transaction`):

- **Signature:**
  ```ts
  recordRecoveryAction(db: AppDb, args: {
    storeId: string; productId: string;
    moveType: 'transfer' | 'expedite' | 'substitute';
    units: number; sourceStoreId: string | null;
    draftedRequest: string; predictedRecapturedUsd: number;
    userEmail: string;
  }): Promise<{ actionId: string; markdownHoldId: string | null }>
  ```
- **What it writes** (one `db.transaction`):
  1. `INSERT INTO app.ops_actions` a row: `move_type`, `store_id`(dest), `product_id`, `units`, `source_store_id`, `drafted_request`, `predicted_recaptured_usd`, `status='approved'`, `approved_by = userEmail`, `audit_trail = [{ at, by: userEmail, action: 'approved', notes: 'Recovery move recorded', tool: 'execute_recovery_action' }]::jsonb`. Return the generated `id`.
  2. **If `moveType === 'transfer'` and `sourceStoreId`**, insert a paired `INSERT INTO app.ops_actions` with `move_type='markdown_hold'`, `store_id = sourceStoreId`, `product_id`, `units=0`, `drafted_request = 'Markdown hold on surplus feeding STORE-… transfer'`, an audit entry with `action:'markdown_hold'`. This is the "hold the source surplus so it isn't discounted" beat. Return its id as `markdownHoldId` (else `null`).
- Use the drizzle `opsActions` table import (already exported from `server/db/schema.ts`) or raw `sql` inserts — either is fine; keep it inside `db.transaction(async (tx) => {...})`.

### 3b. The tool body (in `server/agent/storeops.ts`)

Replace the `execute_recovery_action` stub's `execute` (search `TODO — BUILD 3`):

- **Signature (already declared):** `execute_recovery_action({ store_id, product_id, move_type, units, source_store_id, drafted_request, predicted_recaptured_usd })`.
- Call `recordRecoveryAction(ctx.db, { ...map args..., userEmail: ctx.userEmail })`. Wrap in `mlflow.withSpan(..., { name: 'execute_recovery_action', spanType: mlflow.SpanType.TOOL })`.
- **Return** `{ recorded: true, action_id, store_id, product_id, move_type, units, source_store_id, predicted_recaptured_usd, markdown_hold: <bool> }` so the agent's summary quotes the truth from the write, not its own memory.
- **Approval gate:** the instructions already forbid calling this before the user approves — keep them.

### 3c. The `dataMutated` → Operations refresh cascade

The client is already wired: `client/src/operations/OperationsView.tsx` (and the store map + the position drawer) subscribe to `dataMutated` from `client/src/lib/events.ts` and refetch on every emit. The chat turn already emits `dataMutated` when the agent's turn ends (see `client/src/chat/useChatTurn.ts` → `onTurnEnd` → `dataMutated.emit()`). **So once `execute_recovery_action` writes to `app.ops_actions`, the moment the turn completes:** the Open-shortfalls KPI ticks down (the position now has a recovery action, so `positionSummary` excludes it), the shortfall row flips to **"Recovery in progress"** with a **Transfer** badge (the `listPositions` LEFT JOIN LATERAL picks up the latest `ops_actions` row → `liveMoveType`), the store map's red dot re-colors, lost-sales exposure drops by the recaptured $, and any open drawer re-fetches its Activity timeline. **You do not need to add any client code** — just make the write land. If the cascade doesn't fire, confirm `dataMutated.emit()` runs on turn end and that your write committed.

**Acceptance (Layer 3):** with 2a/2b done, run the full script:
1. *"What's the best recovery move for Store 214?"* → investigate → rank → draft → **STOP**.
2. *"Yes — approve the transfer."* → `execute_recovery_action` writes to `app.ops_actions`. **Watch the Operations page cascade live without a reload:** Open-shortfalls −1, Store 214 row → "Recovery in progress · Transfer", lost-sales exposure −$14K, drawer Activity tab gains the recorded action.

**Paste-to-agent prompt for Layer 3:**
> Implement the Act layer. (1) In `server/db/queries/stores.ts` add `recordRecoveryAction(db, args)` per `APP_WORKSHOP.md` §Layer 3a — a `db.transaction` that inserts an `app.ops_actions` row (status='approved', approved_by from userEmail, an audit entry) and, for a transfer, a paired `markdown_hold` row on the source store. (2) In `server/agent/storeops.ts` implement the `execute_recovery_action` tool body to call it and return the `{recorded:true, ...}` shape. Keep the approval gate in the instructions. The client `dataMutated` cascade is already wired — do not touch client code. Verify the Operations queue updates live after approval.

---

## Build 3 — Unity AI Gateway

Route the agent's model endpoint through **Unity AI Gateway** for a **spend cap**, **guardrails**, and **per-store-attributable inference logging** to a UC table.

**What you configure (mostly workspace + config, minimal app code):**
- **The model endpoint** the agent calls is `config/app.json` → `agentModel` (default `databricks-gpt-5-4`). The OpenAI client points at `${DATABRICKS_HOST}/serving-endpoints/<agentModel>/invocations` (see `configureAgentsSdk` in `server/agent/storeops.ts`, `baseURL: \`${ctx.databricksHost}/serving-endpoints\``). To govern it via the Gateway:
  1. In the workspace, create/enable an **AI Gateway** on the serving endpoint (or a Gateway-fronted endpoint): set a **usage/spend limit** (~$200K/yr bounded per the story), enable **inference logging** to a UC table, and configure **guardrails** (e.g. safety, PII).
  2. Point `agentModel` at that Gateway-governed endpoint name. The app already requests the `ai-gateway` scope in `app.yaml` (`user_authorization.scopes`) — keep it.
- **Per-store attribution:** the agent's every action is OBO-stamped with the user's email (`ctx.userEmail`) and every turn is traced in MLflow; combine the Gateway's inference-log UC table with the `ops_actions.store_id` / `approved_by` columns to attribute spend per store. (Optional talk-track: surface an "AI spend" panel/link in the app that deep-links to the Gateway usage dashboard.)

**Acceptance (Build 3):** the agent still answers normally; the Gateway's inference-log UC table shows one row per model call with the spend cap enforced; you can attribute calls to the store the action targeted.

**Paste-to-agent prompt for Build 3:**
> Route this app's agent model through Unity AI Gateway. The endpoint name is `config/app.json` → `agentModel`, called from `configureAgentsSdk` in `server/agent/storeops.ts` (`baseURL: ${DATABRICKS_HOST}/serving-endpoints`). Point `agentModel` at a Gateway-governed serving endpoint with a spend cap, guardrails, and inference logging to a UC table; the `ai-gateway` OBO scope is already declared in `app.yaml`. Explain how to attribute logged calls per store using `ops_actions.store_id` / `approved_by`.

---

## Quick reference — what ships vs what you build

| Piece | Ships working | You build |
|---|---|---|
| Routing, OBO auth, MLflow tracing, SSE, chat dock | ✅ | — |
| **Layer 1 — Visualize** (store map + shortfall queue + KPIs from Lakebase) | ✅ | — |
| Agent loop + `ask_data` (Genie/MAS, config-driven) | ✅ | pick backend in Build 1 |
| `find_shortfall`, `rank_recovery_moves` | stub (throws) | **Layer 2** (2a + 2b) |
| `search_products` (Lakebase Search for substitutes) | stub (throws) | **Layer 2c** |
| `execute_recovery_action` + `recordRecoveryAction` write | stub (throws) | **Layer 3** |
| `dataMutated` → Operations live cascade | ✅ (fires on your write) | — |
| Unity AI Gateway governance | scope declared | **Build 3** |

**Run it locally:** `./start.sh` (installs deps, builds the frontend, boots on `DATABRICKS_APP_PORT` or `8765`). Reset the demo between runs with the Reset-demo admin action (`POST /api/admin/reset`) — it truncates `ops_actions` + re-syncs the read-only mirrors, so shortfalls return to `stockout`/`at_risk` and exposure returns to full.
