#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ai-workbench}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"

cd "$APP_DIR"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $APP_DIR/$ENV_FILE. Copy .env.production.example and fill secrets first." >&2
  exit 1
fi

required_vars=(
  AUTH_SECRET
  POSTGRES_USER
  POSTGRES_PASSWORD
  POSTGRES_DB
  POSTGRES_URL
  AI_PROVIDER
  DEFAULT_CHAT_MODEL
  TITLE_MODEL
  UPLOAD_DIR
)

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

for var in "${required_vars[@]}"; do
  if [ -z "${!var:-}" ]; then
    echo "Missing required env var: $var" >&2
    exit 1
  fi
done

case "${AI_PROVIDER}" in
  deepseek)
    if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
      echo "AI_PROVIDER=deepseek requires DEEPSEEK_API_KEY" >&2
      exit 1
    fi
    ;;
  openai)
    if [ -z "${OPENAI_API_KEY:-}" ]; then
      echo "AI_PROVIDER=openai requires OPENAI_API_KEY" >&2
      exit 1
    fi
    ;;
  mock)
    echo "Warning: AI_PROVIDER=mock is not suitable for production." >&2
    ;;
  *)
    echo "Unsupported AI_PROVIDER: ${AI_PROVIDER}" >&2
    exit 1
    ;;
esac

mkdir -p ./data/postgres ./data/uploads

docker compose -f "$COMPOSE_FILE" pull postgres || true
docker compose -f "$COMPOSE_FILE" up -d --build
docker compose -f "$COMPOSE_FILE" exec -T app pnpm db:migrate

for attempt in {1..30}; do
  if docker compose -f "$COMPOSE_FILE" exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo "AI Workbench is healthy."
    exit 0
  fi
  echo "Waiting for app health check... ($attempt/30)"
  sleep 3
done

echo "Deployment finished but health check did not pass. Showing recent logs:" >&2
docker compose -f "$COMPOSE_FILE" logs --tail=120 app >&2
exit 1
