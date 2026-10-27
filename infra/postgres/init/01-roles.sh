#!/bin/sh
# Runs only for an empty PostgreSQL volume. Existing roles/data are not reset.
set -eu
: "${APP_DB_PASSWORD:?set the application role password before first boot}"
psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$APP_DB_PASSWORD" --set=owner="$POSTGRES_USER" --set=database="$POSTGRES_DB" <<'SQL'
CREATE ROLE app_user WITH LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
GRANT CONNECT ON DATABASE :"database" TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
SQL
