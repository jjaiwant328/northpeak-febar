# NorthPeak Store Ops — Stockout & Markdown Rescue

A Databricks App that turns an inventory shock into a governed decision loop:
detect stockouts and overstock on a live map, investigate with Genie, rank the
recovery move with a registered ML model, stress-test it with a what-if
simulator, and approve the write through an independent AI policy gate — every
step audited in Lakebase and traced in MLflow.

Built on the Databricks AppKit app template; the authored layer is itemized in
[PROVENANCE.md](PROVENANCE.md) and the AI-assisted build story in
[BUILD_NARRATIVE.md](BUILD_NARRATIVE.md).

## Architecture

```
Lakeflow SDP (northpeak-addons)     raw parquet → silver MVs → gold MVs + metric view
        │                                    rtdemo.northpeak_v2
        ▼
Unity Catalog ── recovery_recommender v6 @prod (XGBoost/Optuna, RMSE $302.71)
        │ batch-scores 150 open shortfalls → gold_recovery_recommendations_ml
        ▼
Lakebase (OLTP) ── mirrors for low-latency reads + ops_actions (the writable table)
        ▲                │ reverse ETL (daily job): ops_actions → ops_actions_outcomes (Delta)
        │                ▼
Databricks App ── map/KPIs, position drawer, assistant (Responses API),
                  Genie over managed MCP, propose → check_policy (guarded
                  AI Gateway, fail-closed) → human approve → Lakebase write
```

Governance: every policy check is logged to a UC inference table (live panel on
the Platform page); every agent turn is an MLflow trace; thumbs feedback lands
back as human assessments. Managed Synced Tables replicate gold into Lakebase.

## Repo layout

| Path | What |
|---|---|
| `client/` | React app (operations map, analytics, embedded AI/BI dashboard, platform page, chat dock) |
| `server/` | Express server — agent (`server/agent/`), chat streaming, Lakebase queries |
| `northpeak-addons/` | Self-contained Databricks Asset Bundle: data generator, silver/gold SQL, ML train+score notebook, reverse-ETL notebook |
| `config/queries/` | Warehouse SQL for the analytics page and governance panel |
| `submission/` | Submission package: artifact map + text execution evidence (run logs, query results, model output) |
| `DEMO_SCRIPT.md` | Six-beat live demo script with paste-ready prompts |
| `scripts/` | Utility scripts (dashboard page builder, Lakebase grants) |

## Deploy

```bash
# app (profile targets the fe-vm-jai-classic-ws workspace)
npm install && npm run build:source
databricks bundle deploy -t app --profile fe-vm-jai-classic-ws
databricks apps deploy northpeak-febar --profile fe-vm-jai-classic-ws   # bundle syncs files; this creates the deployment

# data + ML bundle (raw → gold, model, reverse ETL)
cd northpeak-addons
databricks bundle deploy -t prod --profile fe-vm-jai-classic-ws
```

## Evidence

`submission/evidence/` — 26 text files: pipeline run, table counts, ML job
output, model registry, endpoint invocation, metric-view totals, Genie
transcripts, gateway inference-log counters, synced-table status/counts,
reverse-ETL runs, dashboard publish response, test results. No screenshots;
everything readable as text.
