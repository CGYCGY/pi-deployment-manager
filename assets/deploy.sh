#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load environment variables
if [ -f "${SCRIPT_DIR}/.env.deploy" ]; then
  set -a
  source "${SCRIPT_DIR}/.env.deploy"
  set +a
elif [ -f "deploy/.env.deploy" ]; then
  set -a
  source "deploy/.env.deploy"
  set +a
fi

# Resolve GitHub org and repo name
if [ -z "${GITHUB_ORG:-}" ] || [ -z "${REPO_NAME:-}" ]; then
  REMOTE_URL=$(git remote get-url origin 2>/dev/null || true)
  if [ -n "$REMOTE_URL" ]; then
    REPO_FROM_REMOTE=$(echo "$REMOTE_URL" | sed -E 's#(git@|https://)github\.com[:/]##' | sed 's/\.git$//' | tr '[:upper:]' '[:lower:]')
    GITHUB_ORG="${GITHUB_ORG:-$(dirname "$REPO_FROM_REMOTE")}"
    REPO_NAME="${REPO_NAME:-$(basename "$REPO_FROM_REMOTE")}"
  fi
fi

# Final fallback: repo name defaults to current directory name
REPO_NAME="${REPO_NAME:-$(basename "$(pwd)" | tr '[:upper:]' '[:lower:]')}"

if [ -z "${GITHUB_ORG:-}" ]; then
  echo "Error: GITHUB_ORG not set and no git remote found." >&2
  exit 1
fi

IMAGE="ghcr.io/$(echo "${GITHUB_ORG}/${REPO_NAME}" | tr '[:upper:]' '[:lower:]')"
TAG="${1:-latest}"

PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"

echo "==> Building ${IMAGE}:${TAG} (${PLATFORM})"
docker build --platform "${PLATFORM}" -f deploy/Dockerfile -t "${IMAGE}:${TAG}" .

echo "==> Pushing ${IMAGE}:${TAG}"
docker push "${IMAGE}:${TAG}"

echo "==> Image pushed: ${IMAGE}:${TAG}"

if [ -z "${COOLIFY_WEBHOOK_URL:-}" ] || [ -z "${COOLIFY_API_TOKEN:-}" ]; then
  echo "Error: COOLIFY_WEBHOOK_URL or COOLIFY_API_TOKEN not set; the image is pushed but nothing deployed it." >&2
  exit 1
fi

# POST: Coolify answers a GET on /api/v1/deploy with 405 "This endpoint has changed to a POST
# request." A non-2xx is a failed deploy, not a warning — the image alone changes nothing live.
echo "==> Triggering Coolify redeploy..."
RESPONSE=$(curl -sS -X POST -w $'\n%{http_code}' \
  -H "Authorization: Bearer ${COOLIFY_API_TOKEN}" \
  "${COOLIFY_WEBHOOK_URL}") || {
  echo "Error: Coolify webhook unreachable: ${COOLIFY_WEBHOOK_URL%%\?*}" >&2
  exit 1
}
HTTP_CODE="${RESPONSE##*$'\n'}"
BODY="${RESPONSE%$'\n'*}"
if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  echo "Error: Coolify webhook returned HTTP ${HTTP_CODE}: ${BODY}" >&2
  exit 1
fi
echo "==> Coolify redeploy triggered (HTTP ${HTTP_CODE}): ${BODY}"

echo "==> Done."
