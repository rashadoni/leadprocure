#!/usr/bin/env bash
# Пересев стенда съёмки: новая база, миграции, сид, перезапуск api на неё.
#
# Пересъёмка главы в середине истории не поддерживается намеренно — стенд ведёт список
# снятых глав, и новая база это единственный поддержанный способ начать историю заново.
#
# Свой api останавливается ПО НОМЕРУ процесса и только после проверки, что это он:
# шаблонный `pkill -f node` на этой машине задел бы и api других сессий.
set -euo pipefail
ROOT=/home/rashad/projects/Leadprocure/.claude/worktrees/leadprocure-codex-handoff-0a9f68
DB="$1"; LOG="$2"
cd "$ROOT"
set -a; . /home/rashad/projects/Leadprocure/.env; set +a

docker exec leadprocure_postgres psql -U leadprocure_owner -d postgres \
  -c "CREATE DATABASE $DB OWNER leadprocure_owner" >/dev/null
# Права app_user выдаются ДО миграций, и миграции их не выдают: семь таблиц создаются без
# собственного GRANT и живут на этом умолчании. Без этих четырёх строк сид падает на
# `permission denied for table budgets` посреди работы, оставив базу наполовину засеянной.
docker exec leadprocure_postgres psql -U leadprocure_owner -d "$DB" \
  -c "GRANT CONNECT ON DATABASE $DB TO app_user" \
  -c "GRANT USAGE ON SCHEMA public TO app_user" \
  -c "ALTER DEFAULT PRIVILEGES FOR ROLE leadprocure_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user" \
  -c "ALTER DEFAULT PRIVILEGES FOR ROLE leadprocure_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user" >/dev/null

export DATABASE_OWNER_URL=$(printf '%s' "$DATABASE_OWNER_URL" | sed -E "s#/[A-Za-z0-9_]+(\?|\$)#/$DB\1#")
export DATABASE_URL=$(printf '%s' "$DATABASE_URL" | sed -E "s#/[A-Za-z0-9_]+(\?|\$)#/$DB\1#")
pnpm --filter api migration:run >/dev/null 2>&1
pnpm --filter api seed 2>&1 | tail -1

if [ -f "$ROOT/.stand-api.pid" ]; then
  OLD=$(cat "$ROOT/.stand-api.pid")
  if [ -n "$OLD" ] && [ -d "/proc/$OLD" ] \
     && [ "$(readlink -f "/proc/$OLD/cwd")" = "$ROOT" ] \
     && tr '\0' '\n' < "/proc/$OLD/cmdline" | grep -qx 'apps/api/dist/main.js'; then
    kill "$OLD"; sleep 3
  fi
fi

export S3_BUCKET=leadprocure-guides WEB_ORIGIN=http://127.0.0.1:5179 \
       DISABLE_SCHEDULERS=1 API_PORT=3000 NODE_ENV=development
nohup node apps/api/dist/main.js > "$LOG" 2>&1 &
echo $! > "$ROOT/.stand-api.pid"
for i in $(seq 1 40); do
  curl -fsS --max-time 3 http://127.0.0.1:3000/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS --max-time 5 http://127.0.0.1:3000/health && echo
echo "стенд на базе $DB готов"
