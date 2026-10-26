#!/usr/bin/env bash
set -euo pipefail
node scripts/acceptance/assert-isolated.cjs
backup_file=$(mktemp /tmp/leadprocure-audit-backup.XXXXXX)
trap 'rm -f "$backup_file"' EXIT
pg_dump "$DATABASE_OWNER_URL" -Fc -f "$backup_file"
restore_url="${DATABASE_OWNER_URL%/*}/leadprocure_audit_restore"
createdb --maintenance-db="$DATABASE_OWNER_URL" leadprocure_audit_restore
pg_restore --exit-on-error --dbname="$restore_url" "$backup_file"
original=$(psql "$DATABASE_OWNER_URL" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity")
restored=$(psql "$restore_url" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity")
test "$original" = "$restored"
test "$restored" -gt 20
psql "$restore_url" -v ON_ERROR_STOP=1 -c "SELECT count(*) AS restored_migrations FROM migrations; SELECT count(*) AS restored_invoices FROM invoices;"
dropdb --maintenance-db="$DATABASE_OWNER_URL" leadprocure_audit_restore
printf 'PASS: dump/restore preserves schema, data and %s RLS-enabled tables\n' "$restored"
