#!/usr/bin/env bash
set -euo pipefail

# Finds or clones the pi-deployment-manager checkout, then hands off to its own setup.sh.
# Re-running is the upgrade path for the ~/.gylab clone and for a copied skill folder.

NAME="deploy-via-manager"
GYLAB_DIR="$HOME/.gylab/pi-deployment-manager"
REPO="${PI_DEPLOYMENT_MANAGER_REPO:-https://github.com/CGYCGY/pi-deployment-manager.git}"
DIR="" YES=0
PASS=()

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
warn() { printf '!! %s\n' "$*" >&2; }
need_value() { [ "$#" -ge 2 ] || die "$1 requires a value"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)     need_value "$@"; DIR="$2"; shift 2 ;;
    --repo)    need_value "$@"; REPO="$2"; shift 2 ;;
    -h|--help) cat <<EOF
Usage: setup.sh [--dir <path>] [--repo <url>] [checkout setup.sh options, see its --help]

Checkout: --dir, else \$PI_DEPLOYMENT_MANAGER_DIR, else the checkout this skill folder sits in,
else $GYLAB_DIR (cloned from --repo, \$PI_DEPLOYMENT_MANAGER_REPO or the upstream GitHub
URL, then fast-forwarded on later runs, refreshing this skill folder too when it is a copy).
Every other option (-y) goes to its setup.sh.
EOF
               exit 0 ;;
    -y|--yes)  YES=1; PASS+=("$1"); shift ;;
    *)         PASS+=("$1"); shift ;;
  esac
done

# Checked before cloning so a non-interactive run fails fast. Prompts read /dev/tty, which keeps
# `curl … | bash` interactive; -r alone passes even when there is no controlling terminal.
if [ "$YES" -eq 0 ] && ! (: </dev/tty) 2>/dev/null; then die "no terminal available for prompts; re-run with -y"; fi

is_checkout() { grep -q '"name": *"pi-deployment-manager"' "$1/package.json" 2>/dev/null \
  || { [ -d "$1/manager" ] && [ -f "$1/shared/config.ts" ]; }; }

# readlink -f is missing before macOS 12.3; cd -P still resolves a symlinked skill folder.
SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
SKILL_DIR="$(cd -P "$(dirname "$SELF")" && pwd -P)"
CALLED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)"

# The ~/.gylab clone is the skill's own, so it is the one checkout this script may update. One
# named by --dir or $PI_DEPLOYMENT_MANAGER_DIR is the developer's, even when it is that same path.
OWNED=0
if [ -n "$DIR" ] || [ -n "${PI_DEPLOYMENT_MANAGER_DIR:-}" ]; then DIR="${DIR:-$PI_DEPLOYMENT_MANAGER_DIR}"
  case "$DIR" in "~") DIR="$HOME" ;; "~/"*) DIR="$HOME/${DIR#\~/}" ;; /*) ;; *) DIR="${PWD%/}/$DIR" ;; esac
elif is_checkout "$SKILL_DIR/../../.."; then DIR="$(cd -P "$SKILL_DIR/../../.." && pwd -P)"
  [ "$DIR" != "$(cd -P "$GYLAB_DIR" 2>/dev/null && pwd -P)" ] || { DIR="$GYLAB_DIR"; OWNED=1; }
else DIR="$GYLAB_DIR"; OWNED=1
fi

if [ "$DIR" = "$GYLAB_DIR" ] && [ ! -d "$DIR/.git" ]; then
  # Developer mode leaves only config.json and state/ here, the clone's own gitignored root paths.
  for f in "$DIR"/* "$DIR"/.[!.]* "$DIR"/..?*; do
    [ -e "$f" ] || continue
    case "${f##*/}" in config.json|state|.DS_Store) ;; *) die "$DIR is not a git clone and holds ${f##*/}; move it aside and re-run" ;; esac
  done
  if [ "$YES" -eq 0 ]; then
    printf 'Clone %s into %s? [Y/n] ' "$REPO" "$DIR" >/dev/tty
    IFS= read -r answer </dev/tty || answer=n
    case "${answer:-y}" in [yY]*) ;; *) die "aborted" ;; esac
  fi
  if [ ! -e "$DIR" ]; then
    git clone -q "$REPO" "$DIR" || die "clone of $REPO failed; check the URL (--repo) and your network"
    printf 'cloned %s into %s\n' "$REPO" "$DIR"
  else
    { git -C "$DIR" init -q && git -C "$DIR" remote add origin "$REPO" && git -C "$DIR" fetch -q origin \
      && git -C "$DIR" remote set-head origin --auto >/dev/null \
      && git -C "$DIR" checkout -q --track "$(git -C "$DIR" symbolic-ref --short refs/remotes/origin/HEAD)"
    } || { rm -rf "$DIR/.git"; die "could not fetch $REPO into $DIR; check the URL (--repo) and your network"; }
    printf 'adopted %s as a clone of %s\n' "$DIR" "$REPO"
  fi
elif [ "$OWNED" -eq 1 ]; then
  OLD="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || true)"
  if [ -n "$(git -C "$DIR" status --porcelain)" ]; then warn "local changes in $DIR; skipping update"
  elif ! git -C "$DIR" symbolic-ref -q HEAD >/dev/null || ! git -C "$DIR" remote get-url origin >/dev/null 2>&1; then
    warn "$DIR is detached or has no origin; skipping update"
  elif ! git -C "$DIR" pull -q --ff-only; then warn "could not fast-forward $DIR; continuing with it as is"
  elif [ "$OLD" = "$(git -C "$DIR" rev-parse --short HEAD)" ]; then printf '%s already up to date\n' "$DIR"
  else printf 'updated %s (%s..%s)\n' "$DIR" "$OLD" "$(git -C "$DIR" rev-parse --short HEAD)"
  fi
fi

is_checkout "$DIR" && [ -f "$DIR/setup.sh" ] \
  || die "$DIR is not a pi-deployment-manager checkout with a setup.sh; fix --dir, or update it (git pull) and re-run"

# A copied skill folder would keep running old code while the clone moves on. Only tracked files
# are copied, so user files in the copy survive; a linked folder or one in a checkout is left alone.
if [ "$OWNED" -eq 1 ] && [ ! -L "$CALLED_DIR" ] && [ ! -L "${BASH_SOURCE[0]}" ] && ! is_checkout "$SKILL_DIR/../../.."; then
  n=0
  while IFS= read -r -d '' rel; do
    dst="$SKILL_DIR/${rel#.claude/skills/$NAME/}"
    cmp -s "$DIR/$rel" "$dst" && continue
    mkdir -p "$(dirname "$dst")"
    # Unlink first: cp would truncate in place, and bash is still reading this setup.sh from it.
    rm -f "$dst" && cp "$DIR/$rel" "$dst" || die "could not refresh $dst"
    n=$((n + 1))
  done < <(git -C "$DIR" ls-files -z -- ".claude/skills/$NAME")
  [ "$n" -eq 0 ] || printf 'refreshed %s from %s (%s files changed)\n' "$SKILL_DIR" "$DIR" "$n"
fi

exec bash "$DIR/setup.sh" ${PASS[@]+"${PASS[@]}"}
