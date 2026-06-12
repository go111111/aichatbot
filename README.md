# AI Workbench

AI Workbench is a self-hosted AI chat workbench based on Next.js, React, AI SDK, Auth.js, Drizzle, and PostgreSQL.

The production default is direct DeepSeek API access. OpenAI and mock providers are available through environment variables.

## Features

- Next.js App Router and React chat UI
- DeepSeek direct API integration by default
- Optional OpenAI provider
- Local mock provider for development without an API key
- Auth.js email/password and guest sessions
- PostgreSQL persistence for users, chats, messages, documents, votes, and streams
- Local filesystem upload storage through `UPLOAD_DIR`
- Docker Compose deployment for a standard Tencent Cloud CVM

## Environment

Copy the example file:

```bash
cp .env.example .env.local
```

Required production variables:

```env
AUTH_SECRET=replace-with-a-long-random-secret
POSTGRES_URL=postgres://ai_workbench:password@postgres:5432/ai_workbench
AI_PROVIDER=deepseek
DEFAULT_CHAT_MODEL=deepseek-v4-flash
TITLE_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=replace-with-your-deepseek-api-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
UPLOAD_DIR=/app/uploads
```

For local UI development without a model key, use:

```env
AI_PROVIDER=mock
```

Production must use PostgreSQL. The in-memory fallback is only for local development.

## Local Development

```bash
pnpm install
pnpm db:migrate
pnpm dev
```

Open http://localhost:3000.

## Tencent Cloud Deployment

Full server instructions are in [docs/TENCENT_CLOUD_DEPLOY.md](docs/TENCENT_CLOUD_DEPLOY.md).

Short version for a Tencent Cloud CVM:

```bash
cd /opt/ai-workbench
cp .env.production.example .env.production
# edit .env.production and fill AUTH_SECRET, POSTGRES_PASSWORD, POSTGRES_URL, DEEPSEEK_API_KEY
docker compose up -d --build
curl http://127.0.0.1:3000/api/health
```

For repeat deployments after the env file is ready:

```bash
bash scripts/deploy/tencent-cloud.sh
```

The app listens on port `3000`. For public access, configure Nginx to reverse proxy your domain to `http://127.0.0.1:3000`, then attach an HTTPS certificate.

## Data Persistence

Docker Compose stores data under:

```text
./data/postgres
./data/uploads
```

Back up both directories before upgrading or migrating the server.

## Useful Commands

```bash
pnpm exec tsc --noEmit
pnpm verify
pnpm db:migrate
docker compose logs -f app
docker compose restart app
curl http://127.0.0.1:3000/ping
curl http://127.0.0.1:3000/api/health
```
