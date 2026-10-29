#!/usr/bin/env bash
set -euo pipefail
node scripts/acceptance/assert-isolated.cjs
# Hosted runners may default to a newer pg_dump than the server. Use the
# existing disposable server container's matching clients when CI supplies it.
# Stream archives across stdin/stdout; host paths do not exist in the container.
pg_client() {
  if [[ -n "${ACCEPTANCE_POSTGRES_CONTAINER:-}" ]]; then
    docker exec -i "$ACCEPTANCE_POSTGRES_CONTAINER" "$@"
  else
    "$@"
  fi
}
backup_file=$(mktemp /tmp/leadprocure-audit-backup.XXXXXX)
trap 'rm -f "$backup_file"' EXIT
pg_client pg_dump "$DATABASE_OWNER_URL" -Fc > "$backup_file"
restore_url="${DATABASE_OWNER_URL%/*}/leadprocure_audit_restore"
pg_client createdb --maintenance-db="$DATABASE_OWNER_URL" leadprocure_audit_restore
pg_client pg_restore --exit-on-error --dbname="$restore_url" < "$backup_file"
original=$(pg_client psql "$DATABASE_OWNER_URL" -Atc "SELECT (SELECT count(*) FROM invoices)::text||','||(SELECT count(*) FROM migrations)::text||','||(SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity)::text")
restored=$(pg_client psql "$restore_url" -Atc "SELECT (SELECT count(*) FROM invoices)::text||','||(SELECT count(*) FROM migrations)::text||','||(SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity)::text")
test "$original" = "$restored"
rls_count="${restored##*,}"
test "$rls_count" -gt 20
runtime_count=$(pg_client psql "$restore_url" -v ON_ERROR_STOP=1 -Atc 'SET ROLE app_user; SELECT count(*) FROM invoices' | tail -1)
test "$runtime_count" = 0
pg_client psql "$restore_url" -v ON_ERROR_STOP=1 -c "SELECT count(*) AS restored_migrations FROM migrations; SELECT count(*) AS restored_invoices FROM invoices;"
pg_client dropdb --maintenance-db="$DATABASE_OWNER_URL" leadprocure_audit_restore
printf 'PASS: dump/restore preserves schema, data and %s RLS-enabled tables\n' "$rls_count"
