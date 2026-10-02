# AI Assistant Instructions — northpeak-febar

NorthPeak Store Ops app. Read [README.md](README.md) for architecture,
[PROVENANCE.md](PROVENANCE.md) for template-vs-authored split,
[BUILD_NARRATIVE.md](BUILD_NARRATIVE.md) for the AI-workflow account.

## Hard-won operational rules (learned on this repo — follow them)

- **After `databricks bundle deploy -t app`, run `databricks apps deploy
  northpeak-febar` explicitly.** Bundle syncs files but often creates no new
  deployment; the app keeps serving the pinned snapshot.
- **Never `PUT /api/2.0/serving-endpoints/<name>/ai-gateway` with a partial
  body** — it replaces the whole gateway object (wiped guardrails once).
  Re-read config after any infra mutation.
- **Slide numbers must match the demo-visible number** (metric view /
  dashboard), not any defensible one-off query.
- The agent runs a **per-request** Runner (`configureAgentsSdk` → `ctx.runner`)
  — never reintroduce `setDefaultOpenAIClient` (cross-user credential swap).
- `check_policy` fails closed by design. `gate_error=true` means the gate is
  down, not the draft — the agent must stop, not redraft.
- MLflow init must stay **before** `createApp` (`server/server.ts`) — appkit
  takes the global OTel provider otherwise and traces go no-op.

## AppKit docs

After `npm ci`: `node_modules/@databricks/appkit/CLAUDE.md` and
`node_modules/@databricks/appkit-ui/CLAUDE.md`.
