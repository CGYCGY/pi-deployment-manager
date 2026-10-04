#!/usr/bin/env bash
set -euo pipefail

# Makes THIS checkout runnable: prerequisites, bun install, ~/.gylab data folder, config.
# Never clones or pulls; the skill's setup.sh does that for a skill-mode install.
# Safe to re-run: an existing config is never touched.

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
EXAMPLE="$ROOT/config.json.example"
DATA_DIR="$HOME/.gylab/pi-deployment-manager"
CONFIG="${PI_DEPLOYMENT_MANAGER_CONFIG:-$DATA_DIR/config.json}"
case "$CONFIG" in "~/"*) CONFIG="$HOME/${CONFIG#\~/}" ;; esac
STATE_DIR="$DATA_DIR/state"

ASSUME_YES=0

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BOLD=$'\033[1m'; C_RED=$'\033[31m'; C_YEL=$'\033[33m'; C_GRN=$'\033[32m'; C_OFF=$'\033[0m'
else
  C_BOLD=""; C_RED=""; C_YEL=""; C_GRN=""; C_OFF=""
fi

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$C_GRN" "$C_OFF" "$C_BOLD" "$*" "$C_OFF"; }
die()  { printf '%serror:%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

WARNINGS=""
warn() {
  printf '%s!!%s %s\n' "$C_YEL" "$C_OFF" "$*" >&2
  WARNINGS="$WARNINGS$*
"
}

usage() {
  cat <<EOF
Usage: setup.sh [options]

Sets up this pi-deployment-manager checkout ($ROOT):
checks prerequisites, runs bun install, creates $DATA_DIR/state,
and writes the manager config to $CONFIG if it does not exist yet.

  -y, --yes   non-interactive; write the config from config.json.example as is
  -h, --help  this text

Env: PI_DEPLOYMENT_MANAGER_CONFIG overrides the config path.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes)  ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)         usage >&2; die "unknown argument: $1" ;;
  esac
done

# Opening /dev/tty is the real test: the node exists even when there is no controlling terminal.
has_tty() { ( : </dev/tty ) 2>/dev/null; }

[ -f "$EXAMPLE" ] || die "$EXAMPLE is missing; is $ROOT a pi-deployment-manager checkout?"

step "Prerequisites"
command -v bun >/dev/null 2>&1 \
  || die "bun is required: curl -fsSL https://bun.sh/install | bash (then open a new shell)"
say "bun $(bun --version)"

if command -v pi >/dev/null 2>&1; then
  say "pi found"
else
  warn "pi is not on PATH; the skill driver spawns it to run the manager. Install: npm install -g @earendil-works/pi-coding-agent"
fi

if ! command -v docker >/dev/null 2>&1; then
  warn "docker is not installed; deploys build and push the image with it"
else
  # Read-only look at the Docker CLI config; `docker login` itself is the user's call.
  docker_cfg="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
  ghcr_auth="$(PDM_FILE="$docker_cfg" bun -e '
    const fs = require("fs");
    let c = {};
    try { c = JSON.parse(fs.readFileSync(process.env.PDM_FILE, "utf8")); } catch {}
    const hosts = ["ghcr.io", "https://ghcr.io"];
    if (hosts.some((h) => (c.credHelpers || {})[h])) console.log("helper");
    else if (hosts.some((h) => (c.auths || {})[h])) console.log("auths");
  ')"
  case "$ghcr_auth" in
    auths)  say "docker logged in to ghcr.io" ;;
    helper) say "docker has a credential helper for ghcr.io" ;;
    *)      warn "docker is not logged in to ghcr.io; images are pushed there. Run: docker login ghcr.io" ;;
  esac
fi

if ! command -v gh >/dev/null 2>&1; then
  warn "gh is not installed; the manager uses it for the GHCR image repo. Install it, then: gh auth login"
elif gh auth status >/dev/null 2>&1; then
  say "gh authenticated"
else
  warn "gh is not authenticated; the manager uses it for the GHCR image repo. Run: gh auth login"
fi

command -v curl >/dev/null 2>&1 \
  || warn "curl is not installed; the bundled deploy.sh triggers the Coolify webhook with it"
command -v npx >/dev/null 2>&1 \
  || warn "npx is not installed; needed only to deploy Convex projects (convex deploy)"

step "bun install"
(cd "$ROOT" && bun install)

step "Data folder: $DATA_DIR"
mkdir -p "$STATE_DIR"

# Dotted paths of the config fields setup asks for; each answer defaults to the example's value.
FIELDS="coolify.base_url coolify.api_token coolify.server_uuid coolify.dest_uuid
cloudflare.api_token cloudflare.zone_id cloudflare.zone_name cloudflare.dns_target
convex.deploy_key model thinking"

prompt_field() { # prompt_field <path> <default>; prints the answer
  local answer
  case "$1" in
    *token*|*key*)
      printf '%s%s%s [%s] (hidden): ' "$C_BOLD" "$1" "$C_OFF" "$2" >/dev/tty
      IFS= read -rs answer </dev/tty || die "could not read from the terminal"
      printf '\n' >/dev/tty ;;
    *)
      printf '%s%s%s [%s]: ' "$C_BOLD" "$1" "$C_OFF" "$2" >/dev/tty
      IFS= read -r answer </dev/tty || die "could not read from the terminal" ;;
  esac
  printf '%s' "${answer:-$2}"
}

TMP_CONFIG=""
write_config() {
  local i=0 path def value
  mkdir -p "$(dirname "$CONFIG")"
  # Temp file beside the target so the mv is an atomic rename on the same filesystem.
  TMP_CONFIG="$(mktemp "$CONFIG.tmp.XXXXXX")"
  trap 'rm -f "$TMP_CONFIG"' EXIT
  if [ "$ASSUME_YES" -eq 1 ]; then
    cp "$EXAMPLE" "$TMP_CONFIG"
  else
    say "Enter each value, or press Enter to keep the default shown."
    for path in $FIELDS; do
      def="$(PDM_FILE="$EXAMPLE" PDM_PATH="$path" bun -e '
        const c = JSON.parse(require("fs").readFileSync(process.env.PDM_FILE, "utf8"));
        const v = process.env.PDM_PATH.split(".").reduce((o, k) => (o == null ? o : o[k]), c);
        process.stdout.write(v == null ? "" : String(v));
      ')"
      value="$(prompt_field "$path" "$def")"
      # Env, not argv, so the tokens never show up in ps.
      export "PDM_FIELD_$i=$path" "PDM_VALUE_$i=$value"
      i=$((i + 1))
    done
    PDM_FIELDS="$i" PDM_FILE="$EXAMPLE" PDM_OUT="$TMP_CONFIG" bun -e '
      const fs = require("fs");
      const c = JSON.parse(fs.readFileSync(process.env.PDM_FILE, "utf8"));
      for (let i = 0; i < Number(process.env.PDM_FIELDS); i++) {
        const keys = process.env["PDM_FIELD_" + i].split(".");
        const last = keys.pop();
        keys.reduce((o, k) => o[k], c)[last] = process.env["PDM_VALUE_" + i];
      }
      fs.writeFileSync(process.env.PDM_OUT, JSON.stringify(c, null, 2) + "\n");
    '
  fi
  chmod 600 "$TMP_CONFIG"
  mv "$TMP_CONFIG" "$CONFIG"
  trap - EXIT
}

step "Config: $CONFIG"
if [ -f "$CONFIG" ]; then
  say "exists; left untouched"
else
  if [ "$ASSUME_YES" -eq 0 ] && ! has_tty; then
    die "no terminal available for prompts; re-run with -y to copy config.json.example as is"
  fi
  write_config
  say "written"
fi

# The manager cannot deploy while any of these is still an example value.
PLACEHOLDERS="$(PDM_FILE="$CONFIG" bun -e '
  const out = [];
  const walk = (o, p) => {
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith("_")) continue;
      const path = p ? p + "." + k : k;
      if (v && typeof v === "object") walk(v, path);
      else if (typeof v === "string" && /CHANGE-ME|example\.com/.test(v)) out.push(path + " = " + v);
    }
  };
  const required = ["coolify.base_url", "coolify.api_token", "coolify.server_uuid", "coolify.dest_uuid",
    "cloudflare.api_token", "cloudflare.zone_id", "cloudflare.zone_name", "convex.deploy_key"];
  try {
    const c = JSON.parse(require("fs").readFileSync(process.env.PDM_FILE, "utf8"));
    walk(c, "");
    for (const r of required) {
      const v = r.split(".").reduce((o, k) => (o == null ? o : o[k]), c);
      if (typeof v !== "string" || v === "") out.push(r + " is missing");
    }
  } catch (e) { out.push("(config is not valid JSON: " + e.message + ")"); }
  console.log(out.join("\n"));
')"

# A custom stateDir in an existing config wins over the default for the summary and mkdir.
EFFECTIVE_STATE="$(PDM_FILE="$CONFIG" PDM_DEFAULT="$STATE_DIR" bun -e '
  let s = "";
  try { s = JSON.parse(require("fs").readFileSync(process.env.PDM_FILE, "utf8")).stateDir || ""; } catch {}
  if (s === "~") s = process.env.HOME; else if (s.startsWith("~/")) s = process.env.HOME + s.slice(1);
  process.stdout.write(s || process.env.PDM_DEFAULT);
')"
mkdir -p "$EFFECTIVE_STATE"

step "Summary"
say "checkout  $ROOT"
say "config    $CONFIG"
say "state     $EFFECTIVE_STATE"
say "logs      $EFFECTIVE_STATE/logs/manager.log"

if [ -n "$PLACEHOLDERS" ]; then
  printf '\n%s%s!! The manager cannot deploy until these are filled in (%s):%s\n' \
    "$C_BOLD" "$C_RED" "$CONFIG" "$C_OFF"
  printf '%s\n' "$PLACEHOLDERS" | sed 's/^/   - /'
else
  say ""
  say "config has no placeholder values left"
fi

if [ -n "$WARNINGS" ]; then
  printf '\n%sPrerequisite warnings:%s\n' "$C_YEL" "$C_OFF"
  printf '%s' "$WARNINGS" | sed 's/^/   - /'
fi
