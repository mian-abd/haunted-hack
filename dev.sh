#!/usr/bin/env bash
# One command for the whole demo: loads ./.env, starts actor, server, care-team and web with prefixed logs,
# waits until each one answers, and stops all of them on Ctrl-C. Works with macOS bash 3.2.
set -u
cd "$(dirname "$0")"
[ -f .env ] && { set -a; . ./.env; set +a; }
TERSE=$(command -v terse || echo "$HOME/.bun/bin/terse")
[ -x "$TERSE" ] || { echo "[dev] terse CLI not found. Install it: bunx terse-cli@latest install --yes"; exit 1; }
for d in actor web; do [ -d "$d/node_modules" ] || (cd "$d" && bun install) || exit 1; done # first run on a fresh clone

for port in 7100 8787 8788 5173; do
  lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1 && { echo "[dev] port $port is busy (see: lsof -iTCP:$port -sTCP:LISTEN). Stop that process first."; exit 1; }
done

set -m # each service runs in its own process group, so cleanup kills its whole tree and nothing else
stop() { trap - INT TERM EXIT; for g in $(jobs -p); do kill -- "-$g" 2>/dev/null; done; wait; exit 0; }
trap stop INT TERM EXIT

run() { # name dir command...
  local name=$1 dir=$2; shift 2
  ( cd "$dir" && exec "$@" </dev/null 2>&1 ) | while IFS= read -r line; do printf '[%s] %s\n' "$name" "$line"; done &
}
run actor     actor     env -u OPENAI_API_KEY "$TERSE" actor dev # the key stays out of the actor and the browser bundle
run server    server    bun run start
run care-team care-team bun run start
run web       web       env -u OPENAI_API_KEY bun run dev

for url in http://127.0.0.1:7100 http://localhost:8787 http://localhost:8788/health http://localhost:5173; do
  for i in $(seq 120); do
    curl -s -o /dev/null "$url" && break
    [ "$i" = 120 ] && { echo "[dev] no answer from $url after 60 s, stopping"; exit 1; }
    sleep 0.5
  done
done
echo "[dev] ready · web http://localhost:5173 · server http://localhost:8787 · care-team http://localhost:8788/health · actor http://127.0.0.1:7100"
wait
