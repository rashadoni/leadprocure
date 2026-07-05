#!/bin/sh
# Forward-only migrations run as the owner role on every boot (idempotent — TypeORM
# skips already-applied ones), then the API starts as app_user.
set -e
cd /repo
echo "Running migrations…"
pnpm --filter api migration:run
echo "Starting API…"
exec node apps/api/dist/main.js
