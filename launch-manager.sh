#!/usr/bin/env bash
# launch-manager.sh — start the pi-deployment-manager service.
#
# Spawn-on-demand (NOT a daemon): a project agent spawns this, POSTs a deploy to
# the RPC port, gets a structured result, and the process can exit. Reads config.json
# (the single source of truth) for the model/thinking overrides + state dir; the
# extension itself re-reads config.json via shared/config.ts (self-located).

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
PROJECT_DIR="$SCRIPT_DIR"
CONFIG="$PROJECT_DIR/config.json"
EXTENSION="$PROJECT_DIR/manager/index.ts"

if [[ ! -f "$CONFIG" ]]; then
  echo "launch-manager.sh: ERROR — config.json not found at $CONFIG" >&2
  echo "  Copy config.json.example to config.json and fill in your creds." >&2
  exit 1
fi
if [[ ! -f "$EXTENSION" ]]; then
  echo "launch-manager.sh: ERROR — manager extension not found at $EXTENSION" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "launch-manager.sh: ERROR — jq is required to read config.json" >&2
  exit 1
fi
if ! command -v pi >/dev/null 2>&1; then
  echo "launch-manager.sh: ERROR — 'pi' not on PATH. Install it or run via bash -lic so rc files load PATH." >&2
  exit 1
fi

# expandTilde mirror: config.ts expands a leading ~ against $HOME.
expand_tilde() {
  local p="$1"
  if [[ "$p" == "~" ]]; then printf '%s' "$HOME";
  elif [[ "$p" == "~/"* ]]; then printf '%s/%s' "$HOME" "${p:2}";
  else printf '%s' "$p"; fi
}

RPC_PORT="$(jq -r '.rpc.port' "$CONFIG")"
STATE_DIR="$(expand_tilde "$(jq -r '.stateDir // "~/.pi-deployment-manager"' "$CONFIG")")"
MODEL="$(jq -r '.model // empty' "$CONFIG")"
THINKING="$(jq -r '.thinking // empty' "$CONFIG")"
LOG_FILE="$STATE_DIR/logs/manager.log"

mkdir -p "$STATE_DIR/logs"

export PI_STATE_DIR="$STATE_DIR"
export PI_PROJECT_DIR="$PROJECT_DIR"

echo "launch-manager.sh: starting pi-deployment-manager"
echo "  rpc     : 127.0.0.1:$RPC_PORT (preferred; auto-falls-back if busy)"
echo "  log     : $LOG_FILE"
echo "  model   : ${MODEL:-<pi default>}   thinking: ${THINKING:-<pi default>}"
echo "  pi      : $(command -v pi)   ext: $EXTENSION"
echo

# Non-zero exit keeps the window open (exec bash) so a crash stays inspectable.
keep_open() {
  local code=$?
  if [[ $code -eq 0 ]]; then
    exit 0
  fi
  echo
  echo "launch-manager.sh: pi (manager) exited with code $code."
  echo "Window kept open for inspection. Logs: $LOG_FILE"
  echo "Type 'exit' to close, or re-run: $PROJECT_DIR/launch-manager.sh"
  exec bash
}
trap keep_open EXIT

# cwd = project dir so the extension's relative imports + .pi/ resolve.
cd "$PROJECT_DIR"
PI_ARGS=()
[[ -n "$MODEL" ]] && PI_ARGS+=(--model "$MODEL")
[[ -n "$THINKING" ]] && PI_ARGS+=(--thinking "$THINKING")

# THE GATE. --no-builtin-tools is what makes raw bash/read/write/edit/glob
# UNREPRESENTABLE for the manager LLM — not merely discouraged in a prompt. With it,
# the only tools that exist are the 10 verbs the extension registers (whose code
# enforces the deploy/ sandbox). -nc drops ambient AGENTS.md/CLAUDE.md so no parent-
# repo context leaks in; --no-extensions blocks any other extension from re-adding tools.
exec pi --no-extensions --no-builtin-tools -nc -e "$EXTENSION" --name "pi-deployment-manager" ${PI_ARGS[@]+"${PI_ARGS[@]}"}
