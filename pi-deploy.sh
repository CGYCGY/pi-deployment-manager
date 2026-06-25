#!/usr/bin/env bash
# pi-deploy.sh <project_dir> <subdomain> <intent...> — hand a deploy to the manager.
#
# The spawn-on-demand entry point a project agent runs: if no manager is listening it
# spawns launch-manager.sh, waits for the portfile, then POSTs the deploy and prints the
# JSON DeployResult. The POST blocks until the deploy completes (synchronous RPC).
#
# Note: launch-manager.sh runs an interactive pi session. If your environment can't run
# pi headless (no TTY), start it once in a window — this script reuses a live endpoint.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
CONFIG="$SCRIPT_DIR/config.json"

for bin in jq curl; do
  command -v "$bin" >/dev/null 2>&1 || { echo "pi-deploy: '$bin' is required" >&2; exit 1; }
done
[ -f "$CONFIG" ] || { echo "pi-deploy: config.json not found at $CONFIG (copy config.json.example)" >&2; exit 1; }

PROJECT_DIR="${1:-}"
SUBDOMAIN="${2:-}"
shift 2 2>/dev/null || true
INTENT="${*:-}"
if [ -z "$PROJECT_DIR" ] || [ -z "$SUBDOMAIN" ] || [ -z "$INTENT" ]; then
  echo "usage: pi-deploy.sh <project_dir> <subdomain> <intent...>" >&2
  exit 2
fi

expand_tilde() { case "$1" in "~") printf '%s' "$HOME";; "~/"*) printf '%s/%s' "$HOME" "${1:2}";; *) printf '%s' "$1";; esac; }
STATE_DIR="$(expand_tilde "$(jq -r '.stateDir // "~/.pi-deployment-manager"' "$CONFIG")")"
ENDPOINT="$STATE_DIR/endpoint.json"

# Spawn the manager if no endpoint is published yet, and wait (bounded) for it to bind.
if [ ! -f "$ENDPOINT" ]; then
  echo "pi-deploy: no manager endpoint; spawning launch-manager.sh..." >&2
  mkdir -p "$STATE_DIR"
  nohup "$SCRIPT_DIR/launch-manager.sh" >"$STATE_DIR/manager.out" 2>&1 &
  for _ in $(seq 1 90); do
    [ -f "$ENDPOINT" ] && break
    sleep 1
  done
  [ -f "$ENDPOINT" ] || { echo "pi-deploy: manager did not come up (no $ENDPOINT; see $STATE_DIR/manager.out)" >&2; exit 1; }
fi

PORT="$(jq -r '.port' "$ENDPOINT")"
TOKEN="$(jq -r '.token // empty' "$ENDPOINT")"
[ -n "$TOKEN" ] || TOKEN="$(jq -r '.rpc.token' "$CONFIG")"

PAYLOAD="$(jq -nc \
  --arg pd "$PROJECT_DIR" --arg sd "$SUBDOMAIN" --arg it "$INTENT" --arg rid "cli-$$-$(date +%s)" \
  '{type:"deploy",from:"client",ts:0,requestId:$rid,project_dir:$pd,subdomain:$sd,intent:$it}')"

curl -fsS -X POST "http://127.0.0.1:$PORT/deploy" \
  -H "content-type: application/json" \
  -H "x-pideploy-token: $TOKEN" \
  --data "$PAYLOAD"
echo
