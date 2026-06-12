# Tencent Cloud CVM Deployment

This project is intended to run on a Tencent Cloud CVM with Docker Compose, PostgreSQL, and local upload storage.

## 1. Prepare The CVM

Recommended minimum:

- 2 vCPU / 4 GB RAM
- Ubuntu 22.04 LTS
- Security group opens `22`, `80`, `443`, and optionally `3000` for temporary testing

Install Docker:

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
sudo mkdir -p /opt
sudo chown -R $USER:$USER /opt
git clone <your-repo-url> /opt/ai-workbench
cd /opt/ai-workbench
```

Or upload the project directory to:

```text
/opt/ai-workbench
```

## 3. Configure Production Env

```bash
cd /opt/ai-workbench
cp .env.production.example .env.production
openssl rand -base64 32
nano .env.production
```

Required values:

```env
AUTH_SECRET=<the-openssl-output>
NEXT_PUBLIC_SITE_URL=https://your-domain.com

POSTGRES_USER=ai_workbench
POSTGRES_PASSWORD=<strong-password>
POSTGRES_DB=ai_workbench
POSTGRES_URL=postgres://ai_workbench:<same-strong-password>@postgres:5432/ai_workbench

AI_PROVIDER=deepseek
DEFAULT_CHAT_MODEL=deepseek-v4-flash
TITLE_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=<your-deepseek-api-key>
DEEPSEEK_BASE_URL=https://api.deepseek.com

UPLOAD_DIR=/app/uploads
```

Keep `.env.production` only on the server. Do not commit it.

## 4. Start With Docker Compose

```bash
cd /opt/ai-workbench
docker compose up -d --build
docker compose logs -f app
```

Check health:

```bash
curl http://127.0.0.1:3000/ping
curl http://127.0.0.1:3000/api/health
docker compose ps
```

Expected:

- `/ping` returns `ok`
- `/api/health` returns `"status":"ok"`
- `ai-workbench-app` is `healthy`

## 5. One-Command Server Deploy

After `.env.production` exists:

```bash
cd /opt/ai-workbench
bash scripts/deploy/tencent-cloud.sh
```

The script validates required variables, builds containers, runs migrations, and checks `/api/health`.

## 6. Nginx Reverse Proxy

Install Nginx:

```bash
sudo apt install -y nginx
```

Create `/etc/nginx/sites-available/ai-workbench`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/ai-workbench /etc/nginx/sites-enabled/ai-workbench
sudo nginx -t
sudo systemctl reload nginx
```

Then configure HTTPS with Certbot or Tencent Cloud certificate service.

## 7. Daily Operations

View logs:

```bash
docker compose logs -f app
docker compose logs -f postgres
```

Restart:

```bash
docker compose restart app
```

Upgrade:

```bash
cd /opt/ai-workbench
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
curl http://127.0.0.1:3000/api/health
```

Database unavailable:

```bash
docker compose ps postgres
docker compose logs --tail=120 postgres
```

DeepSeek errors:

- Confirm `DEEPSEEK_API_KEY`
- Confirm CVM can reach `https://api.deepseek.com`
- Check app logs for provider status codes

Uploads fail:

```bash
ls -lah data/uploads
docker compose exec app sh -lc 'ls -lah /app/uploads && touch /app/uploads/.write-test'
```
