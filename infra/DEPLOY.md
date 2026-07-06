# Deploy — demo / production stand

One VPS with Docker. A TLS reverse proxy (Caddy/Traefik/nginx) terminates HTTPS and
routes `app.example.com → web:8080` and `api.example.com → api:3000`.

## 1. Configure
```bash
cd infra
cp .env.prod.example .env.prod
# edit .env.prod: set all *_PASSWORD / *_SECRET / BID_MASTER_KEY_B64 and the two public URLs
```
Generate strong secrets:
```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET, JWT_REFRESH_SECRET
openssl rand -base64 32   # BID_MASTER_KEY_B64
```
`APP_DB_PASSWORD` must equal the `app_user` password in `postgres/init/01-roles.sql`
(change both together before first boot; the init script runs only on an empty volume).

## 2. Build & run
```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```
The API container runs forward-only migrations on boot, then serves on :3000.
The web container serves the built SPA on :8080. Point your TLS proxy at them.

## 3. Seed the demo (optional)
```bash
docker compose -f docker-compose.prod.yml exec api pnpm --filter api seed
```
Creates Acme MMC (admin/approver/user) + two suppliers. Passwords printed in the log.

## 4. Local demo stand (no VPS)
The same stack runs on a laptop for demos — verified end-to-end on macOS/Apple Silicon:
```bash
cd infra && cp .env.prod.example .env.prod
# set secrets; use the local URLs: WEB_ORIGIN=http://localhost:8080, PUBLIC_API_URL=http://localhost:3000
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build \
  postgres minio createbuckets ai-orchestrator api web   # skip clamav (see below)
docker compose -f docker-compose.prod.yml --env-file .env.prod exec api pnpm --filter api seed
open http://localhost:8080   # demo: admin@acme.test / Passw0rd!
```
- Browsers treat `localhost` as a secure context, so the `Secure` refresh cookie works
  without TLS for the local stand (silent session resume verified in Chromium).
- **Apple Silicon**: `clamav/clamav` has no arm64 image — start the listed services only
  and keep `CLAMAV_ENABLED=false`. On an amd64 VPS run the full stack with clamav on.
- The prod stack has its own compose project (`name: leadprocure-prod`), so it coexists
  with the dev stack from `docker-compose.yml` (project `infra`) without replacing its
  containers/volumes. One clash remains: prod `api` and the dev `nest --watch` both bind
  host :3000 — run one at a time.

## 5. Notes
- **TLS is required**: `REFRESH_COOKIE_SECURE=true` means the refresh cookie is only sent
  over HTTPS. Behind the proxy, keep `WEB_ORIGIN`/`PUBLIC_API_URL` as the https URLs.
- **Backups**: `docker compose exec postgres pg_dump -U leadprocure_owner leadprocure > backup.sql`.
- **Upgrades**: `git pull && docker compose -f docker-compose.prod.yml up -d --build` —
  migrations are forward-only and idempotent.
- **MinIO console** on :9001 (create the `leadprocure` bucket on first run).
- For an on-prem client, set `DEPLOYMENT_MODE=on_prem_isolated` and install a server license.
