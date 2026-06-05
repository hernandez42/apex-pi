#!/usr/bin/env bash
# scripts/deploy.sh — one-shot deploy script.
# Usage:  ./scripts/deploy.sh [env-file]
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v fly >/dev/null 2>&1; then
  echo "fly CLI not installed. See https://fly.io/docs/hands-on/install-flyctl/" >&2
  exit 1
fi

if [ ! -f fly.toml ]; then
  echo "creating fly.toml via 'fly launch' (no deploy yet)..."
  fly launch --copy-config --name apex-pi --region sin --no-deploy
fi

ENV_FILE="${1:-.env}"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

: "${LLM_API_KEY:?LLM_API_KEY required (set in $ENV_FILE or export it)}"

# Required secrets (idempotent).
fly secrets set \
  LLM_API_KEY="$LLM_API_KEY" \
  LLM_BASE_URL="${LLM_BASE_URL:-https://api.openai.com/v1}" \
  LLM_MODEL="${LLM_MODEL:-gpt-4o-mini}" \
  ${FEISHU_ENABLED:+FEISHU_ENABLED=1} \
  ${FEISHU_APP_ID:+FEISHU_APP_ID=$FEISHU_APP_ID} \
  ${FEISHU_APP_SECRET:+FEISHU_APP_SECRET=$FEISHU_APP_SECRET} \
  ${FEISHU_VERIFICATION_TOKEN:+FEISHU_VERIFICATION_TOKEN=$FEISHU_VERIFICATION_TOKEN} \
  ${FEISHU_ENCRYPT_KEY:+FEISHU_ENCRYPT_KEY=$FEISHU_ENCRYPT_KEY} \
  ${FEISHU_BOT_NAME:+FEISHU_BOT_NAME=$FEISHU_BOT_NAME} \
  ${APEXMEM_URL:+APEXMEM_URL=$APEXMEM_URL}

# Persistent volume (1 GB).
if ! fly volumes list -j | grep -q "apex_pi_data"; then
  fly volumes create apex_pi_data --size 1 --region "${FLY_REGION:-sin}"
fi

fly deploy --remote-only
fly status
