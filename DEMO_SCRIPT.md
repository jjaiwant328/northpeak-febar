# NorthPeak Store Ops — FE Bar Demo Script

App: https://northpeak-febar-687974281268075.aws.databricksapps.com
Data: `rtdemo.northpeak_v2` (fresh Lakeflow build) · Evidence: `jai_northpeak/submission4/`

## What's new vs v2 (capabilities this demo shows)

**New agent capabilities (visible in the Thinking panel)**

1. **Propose → policy-check → approve** — the assistant drafts a
   `propose_recovery_action` (a `proposed` row in Lakebase), gates it through
   `check_policy` on the guarded AI Gateway endpoint (`jai-northpeak-guarded`,
   verdict PASS/FAIL, fail-closed on error), then `execute_recovery_action`
   flips proposed → approved with a full audit row. Two-stage write with an AI
   policy gate — vs v2's single direct insert.
2. **What-if simulator** — `simulate_recovery` projects baseline vs each move
   side-by-side (revenue risk after, expected recovery, freight, margin impact,
   net, inventory days after) with demand-shock overrides. Live-computed,
   labeled as such. Launched from the drawer's "Simulate what-ifs" button.
3. **Genie over MCP** — `ask_genie` consumes the managed Genie MCP endpoint
   (JSON-RPC 2.0, session handshake, tool discovery) with automatic REST
   fallback. The agent talks to Genie through MCP, not a bespoke REST call.

**New platform depth (real builds, evidence on file)**

4. **ML-scored recommendations** — recovery options in the drawer come from
   `gold_recovery_recommendations_ml`: an XGBoost model trained on 40K
   historical transfer outcomes (Optuna-tuned, RMSE $303 on holdout),
   registered in Unity Catalog as `rtdemo.northpeak_v2.recovery_recommender`
   **v6 @prod**, batch-scored across all 150 open shortfalls.
5. **Real Lakeflow pipeline** — raw → silver → gold built from scratch as a
   self-contained bundle (`northpeak-addons/`): 3.6M+ rows, 3 silver MVs, 4
   gold MVs + a metric view, into a fresh governed schema `rtdemo.northpeak_v2`.
6. **Model serving endpoint** — `northpeak-recovery` (Small, scale-to-zero) is
   READY and was live-invoked: hero transfer predicts $19,530.29, an exact
   match to the batch-scored table. (The app reads the scored table — no
   cold-start dead air on stage; invocation evidence is in
   `submission4/endpoint_score.json`.)
7. **Genie space on the new schema** — 4 tables, 21-line instruction block, 7
   sample questions. Answers match the dashboard (lost-sales $4.93M, markdown
   $4.57M). Saved Q&A in `submission4/genie_answers.txt`.

**Demo heroes (guaranteed data in `rtdemo.northpeak_v2`)**

| Role | Store | SKU | Why |
|---|---|---|---|
| Stockout | `STORE-0214` | `SKU-APP-04412` | ML pick: transfer 121u from `STORE-0377`, ~$19.5K recaptured |
| Stockout (biggest $) | `STORE-0034` | `SKU-APP-04412` | $85.4K lost-sales exposure |
| Overstock | `STORE-0026` | `SKU-APP-04412` | 987 units, velocity 0, $73.7K markdown exposure |

---

## The demo — six beats, ~12 minutes

### Beat 1 · Detect (map + KPIs) — 1 min

Open the app → **Operations**. The map shows ~400 stores colored by status;
the KPI strip shows network lost-sales and markdown exposure.

Say: *"A cold snap moved demand faster than replenishment. Same five apparel
SKUs are selling out in the North and rotting in the South."*

### Beat 2 · Investigate (drawer) — 2 min

Click a red (stockout) store in the north — find **STORE-0214** (search box or
click). Drawer opens on the Shortfall tab: on-hand 0, velocity, weeks of
supply, lost-sales exposure, nearest surplus (**STORE-0377**, ~100 km), and the
**ranked recovery options** — these numbers are ML-scored (point that out).

Say: *"Every number here comes from governed gold tables; the ranking comes
from a registered ML model, not a prompt."*

### Beat 3 · Simulate (what-if) — 2 min

Click **"Simulate what-ifs"** in the drawer. The assistant opens and runs
`simulate_recovery`: baseline vs transfer vs expedite side-by-side, plus the
+20% demand shock scenario.

Say: *"Before committing, the operator stress-tests the recommendation — what
if demand runs hotter?"*

### Beat 4 · Recommend + policy gate (assistant) — 3 min

In the assistant, paste:

```
What's the best recovery move for Store STORE-0214 on SKU SKU-APP-04412?
Propose it, check it against policy, and if it passes, execute it.
```

Watch the Thinking panel: `find_shortfall` → `rank_recovery_moves` →
`propose_recovery_action` (**proposed** row written) → `check_policy`
(verdict PASS via the guarded AI Gateway endpoint) →
`execute_recovery_action` (approved + audit row).

Say: *"The write path is two-stage: the agent proposes, an independent policy
model gates it — fail-closed — and only then does it execute. Every step is a
row in Lakebase with my name on it."*

### Beat 5 · Approve evidence (badge + audit) — 1 min

Back on the map: STORE-0214 now shows **Recovery in progress**; the drawer
shows the approved action with the audit entry.

Say: *"Approval isn't a chat message — it's state. Badge, audit trail,
operator identity."*

### Beat 6 · Investigate with Genie over MCP (assistant) — 3 min

Paste:

```
Ask Genie: how much are we losing to stockouts, and what is our markdown
exposure right now?
```

The agent calls `ask_genie`, which goes through the **managed Genie MCP
endpoint**. Expected answer: ~$4.9M lost-sales, ~$4.6M markdown — matching the
Analytics dashboard. Follow-up if time:

```
Ask Genie: which five stores have the highest lost-sales exposure?
```

Say: *"Genie is a managed MCP server. The app discovers its tools over the MCP
handshake — same protocol an external agent like Claude Desktop would use
against this workspace."*

---

## Optional beats (if asked / if time)

- **Overstock story**: open **STORE-0026** (987 units, velocity 0, $73.7K
  markdown exposure). Ask the assistant to fix the overstock — it recommends
  markdown-hold vs transfer with the live heuristic (labeled live-computed).
- **ML evidence**: `submission4/` — pipeline update COMPLETED, table counts,
  model registry (@prod → v6), endpoint status READY, endpoint invocation JSON
  matching the batch score to the cent.
- **Governance**: every AI call runs through Unity AI Gateway — spend caps,
  guardrails, inference logging; MLflow traces every agent turn
  (`/Shared/solution_builder/northpeak-febar-agent-traces`).

## Fallbacks

- **Transient `403 Invalid Token`**: platform flake; the fetch shim retries
  automatically (up to 2×). Just re-send if it surfaces.
- **Genie slow**: investigations can poll 30–90s — the Thinking panel narrates
  while it works; don't re-send.
- **Endpoint cold start**: `northpeak-recovery` scales to zero; first
  invocation after idle takes ~1 min. Evidence JSON is the safe fallback —
  don't invoke it live on stage.
