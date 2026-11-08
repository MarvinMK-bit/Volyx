#!/usr/bin/env bash
# ============================================================
# One command to bring Volyx up.
#
#   ./start.sh
#
# Why this exists: node_modules is never committed and is not kept in every
# environment, and the one dependency (better-sqlite3) is native — the server
# cannot boot without it. So: install when it is missing, then start.
#
# Extra arguments are passed through, e.g.  ./start.sh --help  is not used;
# environment variables work as usual:  PORT=4000 ./start.sh
# ============================================================
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules/better-sqlite3 ]; then
  echo "→ Installing dependencies (better-sqlite3 has a prebuilt binary, no compiler needed)…"
  npm install --omit=dev
fi

if [ ! -f data/volyx.db ] && [ -f data/db.json ]; then
  echo "→ Found data/db.json — it will be imported into data/volyx.db on first start."
fi

exec npm start
