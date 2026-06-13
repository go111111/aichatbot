# Tencent Cloud CVM Deployment

This project is intended to run on a Tencent Cloud CVM with Docker Compose, PostgreSQL, Redis, and local upload storage.

## 1. Prepare The Tencent Cloud Server

Recommended minimum:

- 2 vCPU / 4 GB RAM
- Ubuntu 22.04 LTS
- Tencent Cloud firewall opens `22`, `80`, and optionally `443`
- The old online exam system can keep using `8081`; AI Workbench will use public port `80`

If you use BT Panel, install Docker from:

```text
BT Panel -> Docker
```

Or install Docker from SSH:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git openssl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker
docker version
docker compose version
```

## 2. Upload Or Clone The Project

Use one of these options.

Clone from Git:

```bash
mkdir -p /www/wwwroot
git clone <your-repo-url> /www/wwwroot/ai-workbench
cd /www/wwwroot/ai-workbench
```

Or upload the project directory to:

```text
/www/wwwroot/ai-workbench
```

## 3. Configure Production Env

```bash
cd /www/wwwroot/ai-workbench
cp .env.production.example .env.production
openssl rand -base64 32
nano .env.production
```

Required values:

```env
AUTH_SECRET=<the-openssl-output>
NEXT_PUBLIC_SITE_URL=http://43.139.14.58
AUTH_URL=http://43.139.14.58
AUTH_SECURE_COOKIES=false

POSTGRES_USER=ai_workbench
POSTGRES_PASSWORD=<strong-password>
POSTGRES_DB=ai_workbench
POSTGRES_URL=postgres://ai_workbench:<same-strong-password>@postgres:5432/ai_workbench

AI_PROVIDER=deepseek
DEFAULT_CHAT_MODEL=deepseek-v4-flash
TITLE_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=<your-deepseek-api-key>
DEEPSEEK_BASE_URL=https://api.deepseek.com

REDIS_URL=redis://redis:6379
UPLOAD_DIR=/app/uploads
OCR_LANGUAGES=eng+chi_sim
OCR_LANG_PATH=
IMAGE_OCR_TIMEOUT_MS=15000
IMAGE_OCR_MAX_BYTES=5242880
```

Keep `.env.production` only on the server. Do not commit it.

## 4. Start With Docker Compose

```bash
cd /www/wwwroot/ai-workbench
docker compose up -d --build
docker compose logs -f app
```

Check health:

```bash
curl http://127.0.0.1:3001/ping
curl http://127.0.0.1:3001/api/health
docker compose ps
```

Expected:

- `/ping` returns `ok`
- `/api/health` returns `"status":"ok"`
- `ai-workbench-app` is `healthy`
- `ai-workbench-postgres` and `ai-workbench-redis` are `healthy`

## 5. One-Command Server Deploy

After `.env.production` exists:

```bash
cd /www/wwwroot/ai-workbench
bash scripts/deploy/tencent-cloud.sh
```

The script validates required variables, builds containers, runs migrations, and checks `/api/health`.

## 6. BT Panel Nginx Reverse Proxy

The recommended final layout is:

```text
http://43.139.14.58       -> AI Workbench
http://43.139.14.58:8081  -> old online exam system
```

In BT Panel, create or edit the site for `43.139.14.58` and use this Nginx config for AI Workbench:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name 43.139.14.58;

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        add_header X-Accel-Buffering no;
    }

    location ~ ^/(\.user.ini|\.htaccess|\.git|\.env|\.svn) {
        return 404;
    }
}
```

Then check and reload Nginx:

```bash
nginx -t
systemctl reload nginx
```

Tencent Cloud firewall must allow port `80`. HTTPS is optional until you bind a real domain.

When you later switch to an HTTPS domain, update these values together:

```env
NEXT_PUBLIC_SITE_URL=https://your-domain.com
AUTH_URL=https://your-domain.com
AUTH_SECURE_COOKIES=true
```

Large files are uploaded in 4MB chunks through `/api/files/chunked/*`, then merged inside the app container. PDF text extraction and image OCR run after the upload is stored, so large PDFs or high-resolution images may stay in the client `Processing` state longer. Tesseract traineddata is cached under `UPLOAD_DIR/.cache/tesseract`; if the CVM cannot access the default language-data source, put traineddata on the server and set `OCR_LANG_PATH`. Keep `IMAGE_OCR_TIMEOUT_MS` and `IMAGE_OCR_MAX_BYTES` bounded so OCR cannot block uploads indefinitely. Keep `client_max_body_size 25m` for normal uploads and per-chunk requests; do not expose `data/uploads` directly through Nginx.

If a chunked upload fails, the client calls `DELETE /api/files/chunked/initiate` to clear the temporary upload session. If users report failed uploads leaving files behind, check `data/uploads/.tmp/chunked` and app logs.

## 7. Daily Operations

View logs:

```bash
docker compose logs -f app
docker compose logs -f postgres
docker compose logs -f redis
```

Restart:

```bash
docker compose restart app
```

Upgrade:

```bash
cd /www/wwwroot/ai-workbench
git pull
bash scripts/deploy/tencent-cloud.sh
```

Backup:

```bash
tar -czf ai-workbench-backup-$(date +%F).tar.gz data .env.production
```

Restore:

```bash
tar -xzf ai-workbench-backup-YYYY-MM-DD.tar.gz
docker compose up -d
```

## 8. Troubleshooting

App is unhealthy:

```bash
docker compose logs --tail=120 app
curl http://127.0.0.1:3001/api/health
```

Database unavailable:

```bash
docker compose ps postgres
docker compose logs --tail=120 postgres
```

Redis unavailable:

```bash
docker compose ps redis
docker compose logs --tail=120 redis
docker compose exec redis redis-cli ping
```

DeepSeek errors:

- Confirm `DEEPSEEK_API_KEY`
- Confirm CVM can reach `https://api.deepseek.com`
- Check app logs for provider status codes

Browser reports too many redirects:

```bash
grep -E '^(NEXT_PUBLIC_SITE_URL|AUTH_URL|AUTH_SECURE_COOKIES)=' .env.production
curl -IL http://43.139.14.58/
```

For plain HTTP IP deployment, use `AUTH_SECURE_COOKIES=false`. For HTTPS domain deployment, use `AUTH_SECURE_COOKIES=true`.

Uploads fail:

```bash
ls -lah data/uploads
docker compose exec app sh -lc 'ls -lah /app/uploads && touch /app/uploads/.write-test'
```

Do not add an Nginx `alias` or static file rule for `data/uploads`. Production file reads should stay behind the app route `/api/files/{id}` so Auth.js session, file ownership, and chat ownership checks run before the file stream is returned. `/uploads/...` is only a compatibility/development route.

Deleting a chat also removes its chat-scoped file metadata, chunks, and stored files on a best-effort basis. Disk deletion failures are logged by the app, so include `docker compose logs -f app` when troubleshooting leaked upload files.
