#!/usr/bin/env bash
set -euo pipefail

# Finds or clones the pi-deployment-manager checkout, then hands off to its own setup.sh.
# Re-running is the upgrade path for the clone this script owns in ~/.gylab.

DEFAULT_REPO="https://github.com/CGYCGY/pi-deployment-manager.git"
GYLAB_DIR="$HOME/.gylab/pi-deployment-manager"
DIR="" REPO="${PI_DEPLOYMENT_MANAGER_REPO:-$DEFAULT_REPO}" YES=0
PASS=()

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
need_value() { [ "$#" -ge 2 ] || die "$1 requires a value"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)  need_value "$@"; DIR="$2"; shift 2 ;;
    --repo) need_value "$@"; REPO="$2"; shift 2 ;;
    -h|--help)
      cat <<EOF
Usage: setup.sh [--dir <path>] [--repo <url>] [project setup.sh options: -y]

Checkout: --dir, else \$PI_DEPLOYMENT_MANAGER_DIR, else the checkout this skill folder sits in,
else $GYLAB_DIR (cloned from --repo, \$PI_DEPLOYMENT_MANAGER_REPO or $DEFAULT_REPO,
and fast-forwarded on later runs). Then runs that checkout's setup.sh.
EOF
      exit 0 ;;
    -y|--yes) YES=1; PASS+=("$1"); shift ;;
    *) PASS+=("$1"); shift ;;
  esac
done

if [ "$YES" -eq 0 ] && ! ( : </dev/tty ) 2>/dev/null; then
  die "no terminal available for prompts; re-run with -y"
fi

# readlink -f is missing before macOS 12.3; cd -P still resolves a symlinked skill folder.
SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || true)"
SKILL_DIR="$(cd -P "$(dirname "${SELF:-${BASH_SOURCE[0]}}")" && pwd -P)"

is_checkout() {
  grep -q '"name": *"pi-deployment-manager"' "$1/package.json" 2>/dev/null \
    || { [ -d "$1/manager" ] && [ -f "$1/shared/config.ts" ]; }
}

abspath() {
  case "$1" in "~") set -- "$HOME" ;; "~/"*) set -- "$HOME/${1#\~/}" ;; esac
  case "$1" in /*) printf '%s' "$1" ;; *) printf '%s' "$PWD/$1" ;; esac
}

OWNED=0
if [ -n "$DIR" ]; then DIR="$(abspath "$DIR")"
elif [ -n "${PI_DEPLOYMENT_MANAGER_DIR:-}" ]; then DIR="$(abspath "$PI_DEPLOYMENT_MANAGER_DIR")"
elif is_checkout "$SKILL_DIR/../../.."; then DIR="$(cd -P "$SKILL_DIR/../../.." && pwd -P)"
else DIR="$GYLAB_DIR"; OWNED=1
fi

if [ "$DIR" = "$GYLAB_DIR" ] && [ ! -d "$DIR/.git" ]; then
  # Developer mode leaves only config.json and state/ here; a later skill-mode install clones over them.
  for f in "$DIR"/* "$DIR"/.[!.]*; do
    [ -e "$f" ] || continue
    case "${f##*/}" in config.json|state|.DS_Store) ;; *) die "$DIR exists, is not a git clone, and holds ${f##*/}; move it aside and re-run" ;; esac
  done
  if [ "$YES" -eq 0 ]; then
    printf 'Clone %s into %s? [Y/n] ' "$REPO" "$DIR" >/dev/tty
    IFS= read -r answer </dev/tty || answer=n
    case "${answer:-y}" in [yY]*) ;; *) die "aborted" ;; esac
  fi
  if [ ! -e "$DIR" ]; then
    mkdir -p "$(dirname "$DIR")"
    git clone -q "$REPO" "$DIR"
  else
    git -C "$DIR" init -q
    git -C "$DIR" remote add origin "$REPO"
    git -C "$DIR" fetch -q origin
    git -C "$DIR" remote set-head origin --auto >/dev/null
    git -C "$DIR" checkout -q --track "$(git -C "$DIR" symbolic-ref --short refs/remotes/origin/HEAD)"
  fi
  printf 'cloned %s into %s\n' "$REPO" "$DIR"
elif [ "$OWNED" -eq 1 ] && [ -z "$(git -C "$DIR" status --porcelain)" ] \
  && git -C "$DIR" symbolic-ref -q HEAD >/dev/null && git -C "$DIR" remote get-url origin >/dev/null 2>&1; then
  git -C "$DIR" pull -q --ff-only || printf 'warning: could not fast-forward %s; continuing with it as is\n' "$DIR" >&2
fi

is_checkout "$DIR" && [ -f "$DIR/setup.sh" ] || die "$DIR is not a pi-deployment-manager checkout"
exec bash "$DIR/setup.sh" ${PASS[@]+"${PASS[@]}"}
