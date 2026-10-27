# Боевой запуск — чек-лист

Состояние на 2026-07-12: код готов к продакшену (аудит пройден, 172 e2e зелёные),
**ждём сервер и домен**. Полная процедура деплоя — в [infra/DEPLOY.md](../infra/DEPLOY.md);
этот файл — что осталось сделать и в каком порядке.

## 1. Инфраструктура (решения владельца)

- [ ] **VPS** (amd64, ≥4 GB RAM, Docker + docker compose). На arm64 ClamAV недоступен —
      см. DEPLOY.md §4.
- [ ] **Домен** + 2 поддомена: `app.<домен>` (SPA) и `api.<домен>` (API).
- [ ] **TLS-прокси** (Caddy — проще всего: 2 строки на поддомен, авто-Let's Encrypt;
      либо nginx/Traefik) → `app → :8080`, `api → :3000`.
- [ ] (позже, опционально) **SMTP** — до тех пор письма идут в лог API (console provider).
      Включение = заполнить `SMTP_*` в `.env.prod` и перезапустить api. Пересборка не нужна.
- [ ] (позже, опционально) **WhatsApp-шлюз** для автонапоминаний: `WHATSAPP_API_URL`,
      `WHATSAPP_TOKEN`, `WHATSAPP_FROM` в env api. Без них шаг WhatsApp логируется как
      SKIPPED, цепочки продолжают работать по e-mail.

## 2. Секреты (на сервере, один раз)

```bash
cd infra && cp .env.prod.example .env.prod
openssl rand -base64 48   # → JWT_ACCESS_SECRET
openssl rand -base64 48   # → JWT_REFRESH_SECRET
openssl rand -base64 32   # → BID_MASTER_KEY_B64  (в идеале — из KMS)
openssl rand -base64 24   # → POSTGRES_OWNER_PASSWORD
openssl rand -base64 24   # → APP_DB_PASSWORD     (см. ниже!)
openssl rand -base64 24   # → S3_SECRET_KEY
```

- [ ] `APP_DB_PASSWORD` должен совпадать с паролем `app_user` в
      `infra/postgres/init/01-roles.sql` — **поменять в обоих местах ДО первого старта**
      (init-скрипт выполняется только на пустом volume).
- [ ] `WEB_ORIGIN=https://app.<домен>`, `PUBLIC_API_URL=https://api.<домен>`.
- [ ] `VITE_DEMO_HINT` — **не задавать** (демо-логины на странице входа показываются
      только при `=1`; это для демо-стендов).
- [ ] `CLAMAV_ENABLED=true` (amd64).
- [ ] Лицензия: для cloud-режима не нужна (dev-fallback = enterprise). Для on-prem
      клиента: `DEPLOYMENT_MODE=on_prem_isolated`, `LICENSE_PUBLIC_KEY_B64`,
      `pnpm license:gen` → `POST /admin/license`.

## 3. Запуск

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

- [ ] **Не** запускать `seed` на боевом стенде (демо-организации с паролем `Passw0rd!`).
      Первый клиент регистрируется через «Регистрация» на странице входа.
- [ ] Smoke: `curl https://api.<домен>/health` → `{"status":"ok"}`; открыть
      `https://app.<домен>`, зарегистрировать организацию, создать заявку.
- [ ] Проверить: refresh-cookie ставится (Secure), CORS пропускает только `WEB_ORIGIN`,
      на логине НЕТ подсказки с демо-паролями.

## 4. Эксплуатация

- [ ] **Бэкапы БД** (cron на сервере, ежедневно + перед каждым обновлением):
      `docker compose -f docker-compose.prod.yml exec postgres pg_dump -U leadprocure_owner leadprocure | gzip > backup-$(date +%F).sql.gz`
- [ ] Обновления: `git pull && docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build`
      (миграции forward-only, применяются на старте api).
- [ ] Node 20 → 22 в Dockerfile'ах api/web — до 2027 (требование AWS SDK v3);
      прогнать полный e2e после бампа.
- [ ] Мониторинг: как минимум uptime-чек на `/health` + алерт.

## Уже сделано в коде (не требует действий)

- HTTPS-only refresh-cookie, helmet, CORS-allowlist, rate-limit (300/мин, логин 10/мин),
  RLS + DEFINER-швы, запечатанные ставки AES-256-GCM, DTO-валидация, пагинация.
- Демо-подсказка логина скрыта в прод-сборках (гейт `VITE_DEMO_HINT`).
- 3-way match пересчитывается при приёмке (счёт, поданный до GRN, больше не виснет
  в DISPUTED навсегда).
- Автонапоминания поставщикам (email/WhatsApp) со стопом по первой ставке.
