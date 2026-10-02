# Build narrative — how AI tools were used, and where they were overridden

This build was developed with AI coding agents (Claude Code; Isaac review
pipeline) in the loop from the first commit. This file documents that workflow
honestly: where the agents carried the work, and where I redirected or
overrode them. The repo's commit history and `submission/addons.md` build
record back every claim.

## Where the agents carried it

- **Batch-scoring fixes** (`recovery_train_score.py`): three serverless
  failures — scoring timeout (`env_manager="virtualenv"` spins a venv per
  executor), two int/float signature mismatches (`move_type_indexed`,
  `same_region`) — were diagnosed and fixed agent-side from the job error
  text. Fixes verified by re-running the job to SUCCESS (run 244048123379424).
- **Genie MCP client** (`server/agent/tools/genie-mcp.ts`): JSON-RPC handshake,
  session-id capture, tool discovery, SSE/JSON duality — agent-written against
  the live endpoint, then hardened twice from observed production behavior
  (async pending handle; camelCase vs snake_case ids).
- **Dashboard page builder** (`scripts/add_ml_dashboard_page.py`): agent
  reverse-engineered the published dashboard's serialized JSON widget schema
  and appended the ML Recovery page idempotently through the Lakeview API.
- **Agent hardening**: per-request Runner (cross-user credential swap),
  403 retry + friendly error, check_policy cold-start retry, supersede-on-
  redraft — agent-implemented, each tied to an observed failure in app logs.

## Where I overrode or redirected the AI

1. **Surplus count 200 → 167.** An agent "verified" the deck's surplus number
   with its own filter (`on_hand >= 50` on affected SKUs → 200) and edited the
   deck. I challenged it against the metric view — the number the dashboard and
   Genie actually show (`overstock_count` = 167) — and reverted the edit. Rule
   that came out of it: slide numbers must match the demo-visible number, not
   any defensible query.
2. **Caught a destructive config write.** While raising the policy endpoint's
   rate limit, the agent used `PUT …/ai-gateway` — a full-object replacement
   that silently wiped the guardrails and usage tracking. I diffed the
   endpoint config after the call, caught the loss, and had the full
   gateway block (guardrails + inference table + tracking) restored from the
   pre-change read. The retry-after-mutation check is now standard practice
   for every infra mutation.
3. **Refused "RMSE-only" ML evidence.** The first pass stopped at a training
   metric. I required the serving endpoint to be invoked live and its
   prediction to match the batch-scored table to the cent before accepting
   the model row as done ($19,530.29 both ways — `endpoint_score.json`).
4. **Reviewer findings gated by verification.** The reviewer agent flagged a
   BLOCKER (per-request OpenAI client installed into a process global —
   cross-user credential swap). I did not take its word: read the SDK's
   Runner/provider API, confirmed the mechanism, then adopted the per-request
   Runner fix. Same pattern for its "act layer lacks idempotency" — confirmed
   against real Lakebase rows before changing the write path.

## What I would tell a team adopting this workflow

Agents are strongest on API-shape archaeology (MCP handshakes, serialized
dashboard JSON, OTel provider races) and weakest on numbers that must match a
human's slide. Keep a human-owned rule — every quoted number traces to a
governed table or a captured run — and the loop stays honest.
