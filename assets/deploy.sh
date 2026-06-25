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

echo "==> Building ${IMAGE}:${TAG}"
docker build -f deploy/Dockerfile -t "${IMAGE}:${TAG}" .

echo "==> Pushing ${IMAGE}:${TAG}"
docker push "${IMAGE}:${TAG}"

echo "==> Image pushed: ${IMAGE}:${TAG}"

if [ -n "${COOLIFY_WEBHOOK_URL:-}" ] && [ -n "${COOLIFY_API_TOKEN:-}" ]; then
  echo "==> Triggering Coolify redeploy..."
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${COOLIFY_API_TOKEN}" \
    "${COOLIFY_WEBHOOK_URL}")
  if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
    echo "==> Coolify redeploy triggered (HTTP ${HTTP_CODE})"
  else
    echo "Warning: Coolify webhook returned HTTP ${HTTP_CODE}" >&2
  fi
else
  echo "==> No COOLIFY_WEBHOOK_URL or COOLIFY_API_TOKEN set. Skipping redeploy trigger."
fi

echo "==> Done."
