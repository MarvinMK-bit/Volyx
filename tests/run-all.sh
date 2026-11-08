#!/usr/bin/env bash
# Runs every Volyx suite against a throwaway copy of the app on :3100.
# The copy gets its own empty data/ so signups and uploads never touch your real db.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$(cd "$here/.." && pwd)"

if [ ! -d "$here/node_modules" ]; then
  echo "Installing test dependencies (jsdom)…"
  ( cd "$here" && npm install --silent ) || { echo "npm install failed"; exit 1; }
fi

if [ ! -d "$app/node_modules" ]; then
  echo "Installing app dependencies (better-sqlite3)…"
  ( cd "$app" && npm install --silent ) || { echo "npm install failed"; exit 1; }
fi

tmp="$(mktemp -d)"
cp -r "$app"/server.js "$app"/package.json "$app"/lib "$app"/config "$app"/public "$tmp"/ 2>/dev/null
ln -s "$app/node_modules" "$tmp/node_modules"

( cd "$tmp" && PORT=3100 HOST=127.0.0.1 node server.js > "$tmp/server.log" 2>&1 & echo $! > "$tmp/pid" )
for _ in $(seq 1 40); do
  curl -sf http://127.0.0.1:3100/api/health > /dev/null && break
  sleep 0.25
done

failed=0
for suite in api.test.mjs platform.api.test.mjs platform.ui.test.mjs viewer.ui.test.mjs upload.ui.test.mjs design.ui.test.mjs backend.api.test.mjs backend.ui.test.mjs mail.api.test.mjs; do
  printf '%-24s ' "$suite"
  if ( cd "$here" && BASE=http://127.0.0.1:3100 node "$suite" 2>/dev/null | grep -q 'PASSED' ); then
    echo "ok"
  else
    echo "FAILED"
    ( cd "$here" && BASE=http://127.0.0.1:3100 node "$suite" 2>&1 | grep -E '^FAIL' | head -20 )
    failed=1
  fi
done

kill "$(cat "$tmp/pid")" 2>/dev/null
rm -rf "$tmp"
exit $failed
