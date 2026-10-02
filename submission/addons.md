# NorthPeak FE Bar — Executed Build Record

This file records what was actually built, the exact commands that ran, and
where the execution evidence lives. Baseline was the Databricks AppKit app
template; everything below is the authored layer (see ../PROVENANCE.md).

Evidence bundle: `submission/evidence/` (in this repo)
Repo: `jjaiwant328/northpeak-febar` (public, submission);
`jaiwant-jonathan_data/northpeak-febar` (private mirror).

---

## W1 — Repos

```bash
gh repo create jaiwant-jonathan_data/northpeak-febar --private
# public submission repo: jjaiwant328/northpeak-febar (main force-pushed after
# the deck was scrubbed from history — deck ships as the form attachment only)
# local working copy: ~/DBXApps/northpeak_v2/northpeak-febar  (own git repo)
```

Why the one-off token URL: osxkeychain serves a different GitHub account
(jjaiwant328) for github.com; embedding the `gh auth token` in the push URL
authenticates as `jaiwant-jonathan_data` without touching git config.

## W2 — Fresh Lakeflow pipeline → `rtdemo.northpeak_v2`

Self-contained bundle `northpeak-febar/northpeak-addons/` (generator + all SQL
copied in — nothing referenced from /Shared):

```bash
cd northpeak-febar/northpeak-addons
databricks bundle deploy -t prod --profile fe-vm-jai-classic-ws
databricks bundle run northpeak_gen_v2  -t prod   # ~3.9M raw rows → UC volume
databricks bundle run northpeak_ops_v2  -t prod   # SDP: read_files → silver MVs → gold MVs
```

Key decisions hit during execution:

- **prod target, not dev** — dev target prefixes the schema
  (`dev_jaiwant_jonathan_northpeak_v2`); the app + Genie need the stable name
  `northpeak_v2`. Prod targets require an explicit `workspace.root_path`.
- **`file:` libraries, not `notebook:`** for .sql in the pipeline spec.
- **Metric view via `WITH METRICS LANGUAGE YAML` DDL** — classic SQL warehouse
  rejects `CREATE METRIC VIEW` syntax.

Evidence: `submission4/pipeline_run.txt` (update COMPLETED), `table_counts.txt`
(silver_sales 3,309,000 · silver_inventory 254,900 · silver_transfers 40,000 ·
gold_store_sku_position 126,889 · gold_open_shortfalls 150 ·
gold_transfer_outcomes 40,000 · gold_recovery_recommendations 150).

## W3 — Real ML: XGBoost → UC `@prod` → shadow `_ml` table → serving endpoint

```bash
databricks bundle run northpeak_ml_v2 -t prod   # transformation/recovery_train_score.py
```

Notebook: widgets catalog/schema → trains XGBoost on `gold_transfer_outcomes`
(label `recaptured_sales_usd`, 7 features, Optuna 10 trials) → pyfunc wrapper →
registers `rtdemo.northpeak_v2.recovery_recommender` + `@prod` alias → builds 3
candidate moves per open shortfall → batch-scores with
`mlflow.pyfunc.spark_udf` → writes `gold_recovery_recommendations_ml` with the
live-key move_ranking JSON convention.

Three failures fixed en route (all in the scoring section):

1. `MlflowException: Scoring timeout` — `env_manager="virtualenv"` spins a fresh
   venv per executor on serverless; first batch times out. Fix:
   `env_manager="local"` (job env already has xgboost).
2. `Incompatible input types for column move_type_indexed. Can not safely
   convert float64 to int32` — signature inferred int from `cat.codes`;
   candidates cast to double. Fix: `.cast("int")`.
3. Same for `same_region` — null region joins make it float64-with-NaN. Fix:
   `F.coalesce(bool, F.lit(False)).cast("int")`.

Also: `mlflow.set_experiment` NOT_FOUNDs unless the parent folder exists —
`WorkspaceClient().workspace.mkdirs(parent)` first.

Result (run 244048123379424, SUCCESS): model **v6 @prod**, RMSE **$302.71**,
150 shortfalls scored, mix **40 transfer / 110 expedite / 0 substitute**
(substitute's margin impact never wins net value — expected), hero
STORE-0214×SKU-APP-04412 → **transfer 121u from STORE-0377, $19.5K recaptured**.
Evidence: `ml_run.txt`, `model_registry.txt`.

Serving endpoint:

```bash
curl -X POST $HOST/api/2.0/serving-endpoints -d '{
  "name": "northpeak-recovery",
  "config": {"served_entities": [{
    "entity_name": "rtdemo.northpeak_v2.recovery_recommender",
    "entity_version": "6", "workload_size": "Small",
    "scale_to_zero_enabled": true}]}}'
```

Evidence: `endpoint_status.json`, `endpoint_score.json` (live invocation).

Note (honesty table): the app does **not** call this endpoint live from the
agent loop — cold-start dead air demos badly. The app reads the `_ml` shadow
table the endpoint's model scored. The endpoint exists, is invocable, and the
invocation evidence is captured.

## W4 — Genie space wired to v2 tables

Space `01f1a24bf79019f98136bd1b5aea29c8` ("NorthPeak Store Operations"), was
empty. PATCH `/api/2.0/genie/spaces/{id}` with `?include_serialized_space=true`
GET first. Format traps hit (each rejected until fixed):

- tables must be **sorted by identifier**;
- `text_instructions` accepts **at most ONE** item (21 lines merged into one
  `content` array);
- `sample_questions[].question` is an **array**, and each needs
  `"id": "<32-hex-no-hyphens>"` (md5 of the question).

Result: 4 tables, 21-line instruction block, 7 sample questions. Three
questions asked and answered with SQL over `rtdemo.northpeak_v2`
(`genie_answers.txt`): lost-sales $4.93M vs markdown $4.57M (matches the metric
view / dashboard), top-5 stores by lost-sales exposure, recaptured value by
move type.

## W5 — Act layer: proposed → approved + `check_policy` (AI Gateway)

`server/db/queries/stores.ts`: `proposeRecoveryAction` (insert
`ops_actions.status='proposed'` + audit) and `approveRecoveryAction`
(`SELECT … FOR UPDATE` latest proposed row → flip to approved + audit append +
paired markdown_hold on the transfer source store).

`server/agent/storeops.ts` tools:

- `propose_recovery_action` — draft-stage write;
- `check_policy` — POST to guarded AI Gateway endpoint `jai-northpeak-guarded`
  (llama-3.1-8b + guardrails + spend caps + inference logging), 4 policy rules,
  parses `VERDICT: PASS|FAIL`, **fail-closed** on error;
- `execute_recovery_action` — approves the proposed row (falls back to legacy
  `recordRecoveryAction`).

Agent instructions: Phase 2 proposes, Phase 3 requires check_policy PASS before
execute — the Thinking panel shows the full Detect → Investigate → Recommend →
Policy-check → Approve chain.

## W6 — MCP

- **Consume**: `server/agent/tools/genie-mcp.ts` — JSON-RPC 2.0 over the managed
  endpoint `/api/2.0/mcp/genie/<space_id>`: initialize (captures
  `mcp-session-id`) → notifications/initialized → tools/list (discovers the
  query tool + arg name from inputSchema) → tools/call; parses SSE or JSON.
  `genie.ts` tries MCP first, REST fallback; `GENIE_MCP=0` forces REST.
- **Surface (zero-code)**: managed UC-functions MCP endpoint
  `/api/2.0/mcp/functions/rtdemo/northpeak_v2` — documented for external
  clients; `claude mcp add` not shown live on stage.

## W8 — What-If Simulator

`simulate_recovery` tool: baseline vs each move — revenue risk after, expected
recovery, freight, margin impact, net, inventory days after; `units` +
`demand_shock_pct` overrides; labeled "live-computed". Drawer gets a second CTA
("Simulate what-ifs", `client/src/operations/tabs/ShortfallTab.tsx`) that
scripts the simulation prompt through `dockController.openAndSend`.

## W7 — App deploy + evidence

`northpeak-febar/databricks.yml` got its own identity before deploy —
`bundle.name: northpeak-febar`, `root_path: …/northpeak-febar/${bundle.target}`,
app_name `northpeak-febar`, Lakebase `projects/northpeak/branches/dev`
(created via SDK `w.postgres.create_branch` from `branches/app`; the raw REST
body kept failing expiry validation — SDK `BranchSpec(no_expiry=True)` is the
working shape).

```bash
databricks bundle deploy -t app --profile fe-vm-jai-classic-ws   # creates app + syncs dist
# scopes do NOT apply from app.yaml — raw API required (nested app object!):
curl -X POST $HOST/api/2.0/apps/northpeak-febar/update -d '{
  "update_mask": "user_api_scopes",
  "app": {"name": "northpeak-febar", "user_api_scopes": ["model-serving","genie",
    "sql","postgres","ai-gateway","catalog.catalogs:read","catalog.schemas:read",
    "catalog.tables:read"]}}'
```

App live: https://northpeak-febar-687974281268075.aws.databricksapps.com
(`app.yaml` → `DEMO_SCHEMA=northpeak_v2`, `PIPELINE_ID=f456d45a-…`,
`config/app.json` → `gold_recovery_recommendations_ml`).

The original v2 app (`jai-northpeak`) was left untouched and is still running.

## Deferred / completed since

Built after this record: W9 governance panel, W11 ML dashboard page, managed
Synced Tables, reverse ETL (W10's sync half). Still deferred: W10 realized-
outcome labels, W12 Command Center rework, W13 eval harness.
