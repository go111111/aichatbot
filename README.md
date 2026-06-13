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
- Redis-backed IP rate limiting and active stream cache
- Local filesystem upload storage through `UPLOAD_DIR`
- Authenticated file access through `/api/files/{id}`
- Lightweight knowledge retrieval with text file chunking and keyword scoring
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
REDIS_URL=redis://redis:6379
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
cd /www/wwwroot/ai-workbench
cp .env.production.example .env.production
# edit .env.production and fill AUTH_SECRET, POSTGRES_PASSWORD, POSTGRES_URL, DEEPSEEK_API_KEY
docker compose up -d --build
curl http://127.0.0.1:3001/api/health
```

For repeat deployments after the env file is ready:

```bash
bash scripts/deploy/tencent-cloud.sh
```

The app container listens on port `3000`, and Docker publishes it to the server as `127.0.0.1:3001`. For public access through BT Panel/Nginx, reverse proxy `http://43.139.14.58` to `http://127.0.0.1:3001`.

## Data Persistence

Docker Compose stores data under:

```text
./data/postgres
./data/redis
./data/uploads
```

Uploaded files are stored on disk, but production reads should go through `/api/files/{id}` so the BFF can check login state, file ownership, and chat ownership before streaming bytes. The legacy `/uploads/...` route is kept only for compatibility and local development; do not expose `./data/uploads` as a public Nginx static directory.

Uploaded files can be deleted through `DELETE /api/files/{id}`. The route uses the same ownership checks, removes `FileChunk` rows and file metadata, then best-effort deletes the stored disk file.

For text knowledge files, PostgreSQL stores both the file metadata and `FileChunk` rows. Chat requests use the current user question to keyword-score chunks and inject only the top retrieved snippets into the model prompt. Redis is reserved for short-lived rate-limit counters and stream chunk/meta cache.

Back up both directories before upgrading or migrating the server.

## Useful Commands

```bash
pnpm exec tsc --noEmit
pnpm verify
pnpm db:migrate
docker compose logs -f app
docker compose logs -f redis
docker compose restart app
curl http://127.0.0.1:3001/ping
curl http://127.0.0.1:3001/api/health
```
