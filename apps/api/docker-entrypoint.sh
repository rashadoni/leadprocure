#!/bin/sh
# Cloud Run services should not keep the database-owner credential. Migrations run
# only in an explicitly configured release job; the API itself uses app_user.
set -e
cd /repo
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  : "${DATABASE_OWNER_URL:?DATABASE_OWNER_URL is required when RUN_MIGRATIONS=true}"
  echo "Running migrations..."
  pnpm --filter api migration:run
fi
echo "Starting API…"
exec node apps/api/dist/main.js
