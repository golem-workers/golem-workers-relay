#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${1:-openclaw.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "[openclaw] env file not found: $ENV_FILE"
  echo "[openclaw] create it via: cp openclaw.env.example openclaw.env"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  echo "[openclaw] OPENCLAW_GATEWAY_TOKEN is required in $ENV_FILE"
  exit 1
fi
if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo "[openclaw] OPENROUTER_API_KEY is required in $ENV_FILE"
  exit 1
fi

GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
GATEWAY_BIND="${OPENCLAW_GATEWAY_BIND:-lan}"

echo "[openclaw] running non-interactive onboard inside container"
docker compose --env-file "$ENV_FILE" --profile cli run --rm --build openclaw-cli \
  onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice openrouter-api-key \
  --openrouter-api-key "$OPENROUTER_API_KEY" \
  --gateway-auth token \
  --gateway-token "$OPENCLAW_GATEWAY_TOKEN" \
  --gateway-bind "$GATEWAY_BIND" \
  --gateway-port "$GATEWAY_PORT" \
  --skip-health

echo "[openclaw] restarting gateway container"
docker compose --env-file "$ENV_FILE" up -d --build openclaw-gateway

echo "[openclaw] done; Control UI: http://127.0.0.1:${GATEWAY_PORT}/"
echo "[openclaw] WS URL for relay: ws://127.0.0.1:${GATEWAY_PORT}"

