#!/usr/bin/env bash
# Local dev launcher: free the dev port, then `npm run dev`.
# The deployed app does NOT use this script — app.yaml starts
# `node --env-file-if-exists=.env dist/server.js` directly.
set -uo pipefail

cd "$(dirname "$0")"

# Workspace profile for local dev (CLI auth resolution).
export DATABRICKS_PROFILE="${DATABRICKS_PROFILE:-fe-vm-jai-classic-ws}"

APP_PORT="${DATABRICKS_APP_PORT:-8765}"
export DATABRICKS_APP_PORT="$APP_PORT"
# HMR port derived from APP_PORT so concurrent dev servers don't collide
# their Vite WebSockets (vite.config.ts reads VITE_HMR_PORT).
export VITE_HMR_PORT=$((APP_PORT + 1000))

kill_port() {
  local pids
  pids=$(lsof -ti:"$1" 2>/dev/null || true)
  if [ -n "${pids:-}" ]; then
    echo "[start.sh] killing pids on :$1 → $pids"
    kill -9 $pids 2>/dev/null || true
  fi
}

kill_port "$APP_PORT"
kill_port "$VITE_HMR_PORT"

if [ ! -d node_modules ]; then
  echo "[start.sh] node_modules missing — run npm install first"
  exit 1
fi

exec npm run dev
