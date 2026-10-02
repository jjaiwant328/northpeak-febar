# Provenance — what is template, what is authored

This repo started from the Databricks **AppKit "Action-Taking Agent" app
template** (the standard `databricks apps` scaffold: Express + React + Lakebase
wiring, chat streaming shell, AppKit plugins). That baseline is infrastructure.
Everything that makes this a NorthPeak Store Ops decision platform is authored
net-new work for this build, listed below with its evidence.

## Template baseline (not claimed as original work)

- AppKit server/client plumbing: `createApp` boot, plugin set (server,
  lakebase, analytics), chat SSE streaming shell, drizzle migrations
- `start.sh`, `appkit.plugins.json`, tsconfig/tsdown/vite scaffolding
- Generic chat UI components (message bubble, thinking panel) — restyled

## Authored layer (this build)

| Component | Where | Evidence |
|---|---|---|
| Synthetic data generator — single explainable anomaly (cold snap: North ramps, South rots), decay curves, haversine surplus match, ai_classify markdown-risk pass | `northpeak-addons/data_generation/generate_data.py` | `submission/evidence/table_counts.txt` (3.6M+ rows) |
| Lakeflow SDP pipeline — raw → 3 silver MVs → 4 gold MVs + metric view, self-contained bundle | `northpeak-addons/databricks.yml`, `northpeak-addons/transformation/{silver,gold}/` | `submission/evidence/pipeline_run.txt`, `bundle_resources.txt` |
| ML model — XGBoost + Optuna, custom pyfunc, UC registry `@prod`, batch-scored recommendations | `northpeak-addons/transformation/recovery_train_score.py` | `ml_run.txt`, `ml_job_task_output.json`, `model_registry.txt`, `endpoint_score.json`, `model_eval.txt` |
| Reverse ETL — Lakebase `ops_actions` → Delta, idempotent MERGE, daily schedule, retrain chained after it | `northpeak-addons/transformation/reverse_sync_outcomes.py`, `northpeak-addons/databricks.yml` | `reverse_sync_run.txt`, `ops_actions_outcomes_counts.txt` |
| Act layer — two-stage write: propose → independent policy gate on a guarded AI Gateway endpoint (fail-closed) → human approve, audited; supersede-on-redraft; revision-on-approve | `server/agent/storeops.ts`, `server/db/queries/stores.ts` | `governance_summary.txt`, demo beat 4 |
| Genie over managed MCP — JSON-RPC handshake, tool discovery, async poll_response handling, REST fallback | `server/agent/tools/genie-mcp.ts` | `genie_answers.txt` |
| What-if simulator — live-computed baseline vs move projections with demand-shock overrides | `server/agent/storeops.ts` (`simulate_recovery`) | demo beat 3 |
| Governance panel — live counts from the gateway inference log on the Platform page | `config/queries/governance_summary.sql`, `client/src/platform/PlatformView.tsx` | `governance_summary.txt` |
| ML Recovery dashboard page — move mix, counters, top-moves table on the published AI/BI dashboard | `scripts/add_ml_dashboard_page.py` | `dashboard_ml_page.json` |
| Managed Synced Tables — gold → Lakebase (1 continuous-CDC, 2 snapshot) | workspace objects, created via `databricks postgres create-synced-table` | `synced_tables_status.json`, `synced_tables_counts.txt` |
| Agent hardening — per-request Runner (no cross-user credential swap), 403 retry/friendly errors, MCP async polling, early MLflow init (global OTel provider race) | `server/agent/storeops.ts`, `server/chat-stream/agent-stream.ts`, `server/server.ts`, `server/lib/mlflow.ts` | `demo_test_results.txt` |
| Deck + demo script | `DEMO_SCRIPT.md`, deck (attached via submission form) | — |

## Explicitly deferred (next steps, not hidden)

- **Row-level / attribute-based access control** on the store-position tables —
  the governance step after this build; needs a table redesign keyed to operator
  regions.
- **Feeding `ops_actions_outcomes` into retraining as labels** — the table has
  predicted values, not realized fulfillment; wiring realized outcomes into
  `recovery_train_score.py` is the real closed loop.
- **Daily regional action brief** (Genie investigation + ranked move as one
  narrative) — future work.
