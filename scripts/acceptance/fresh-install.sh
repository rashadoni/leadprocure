#!/usr/bin/env bash
# Heavy fresh-install verification belongs only to an ephemeral GitHub runner.
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true && ${RUNNER_ENVIRONMENT:-} == github-hosted ]]
[[ ${GITHUB_RUN_ID:-} =~ ^[0-9]+$ ]]
task_root=$(git rev-parse --show-toplevel)
fixture_dir="$RUNNER_TEMP/leadprocure-fresh-$GITHUB_RUN_ID"
project="leadprocure-acceptance-$GITHUB_RUN_ID"
mkdir -m 700 "$fixture_dir" "$fixture_dir/license" "$fixture_dir/evidence"
export FRESH_FIXTURE_DIR="$fixture_dir"
bash "$task_root/scripts/acceptance/fresh-tls.sh"
python3 <<'PY'
import json, os, secrets
from pathlib import Path
p=Path(os.environ['FRESH_FIXTURE_DIR'])
env={
 'POSTGRES_DB':'leadprocure_fresh_test', 'POSTGRES_OWNER_USER':'acceptance_owner',
 'POSTGRES_OWNER_PASSWORD':secrets.token_hex(24), 'APP_DB_PASSWORD':secrets.token_hex(24),
 'DEPLOYMENT_MODE':'on_prem_isolated', 'JWT_ACCESS_SECRET':secrets.token_hex(48),
 'JWT_REFRESH_SECRET':secrets.token_hex(48), 'BID_MASTER_KEY_B64':__import__('base64').b64encode(secrets.token_bytes(32)).decode(),
 'S3_ACCESS_KEY':'isolated-install', 'S3_SECRET_KEY':secrets.token_hex(32), 'S3_BUCKET':'leadprocure-install-test',
 'WEB_ORIGIN':'https://app.leadprocure.test:39443', 'PUBLIC_API_URL':'https://api.leadprocure.test:39443',
 'S3_PUBLIC_URL':'https://s3.leadprocure.test:39443', 'CLAMAV_ENABLED':'true', 'LICENSE_DIR':str(p/'license'),
}
(p/'fixture.env').write_text(''.join(f'{k}={v}\n' for k,v in env.items()))
# !override removes the template's host-wide ports. Never bind this fixture publicly.
(p/'override.yml').write_text('''services:
  minio:
    pull_policy: never
    ports: !override ["127.0.0.1:39000:9000"]
  api:
    image: leadprocure-acceptance-api:'''+os.environ['GITHUB_RUN_ID']+'''
    ports: !override ["127.0.0.1:39300:3000"]
  web:
    ports: !override ["127.0.0.1:39380:80"]
  tls-proxy:
    image: nginx:alpine
    depends_on: [api, web, minio]
    ports: ["127.0.0.1:39443:443"]
    volumes:
      - "'''+str(p/'tls')+''':/test-tls:ro"
      - "'''+str(p/'tls/nginx.conf')+''':/etc/nginx/nginx.conf:ro"
  legacy-storage:
    profiles: [storage-upgrade]
    image: leadprocure-object-storage:source-7aac2a2
    pull_policy: never
    entrypoint: [/legacy/minio]
    command: [server, /data]
    environment:
      MINIO_ROOT_USER: legacy-fixture-access
      MINIO_ROOT_PASSWORD: legacy-fixture-secret-never-production
    ports: ["127.0.0.1:39500:9000"]
    volumes:
      - legacy-upgrade:/data
      - "'''+str(p/'legacy-minio')+''':/legacy/minio:ro"
  upgraded-storage:
    profiles: [storage-upgrade]
    image: leadprocure-object-storage:source-7aac2a2
    pull_policy: never
    command: [server, /data]
    environment:
      MINIO_ROOT_USER: legacy-fixture-access
      MINIO_ROOT_PASSWORD: legacy-fixture-secret-never-production
    ports: ["127.0.0.1:39500:9000"]
    volumes: [legacy-upgrade:/data]
volumes:
  legacy-upgrade:
''')
PY
compose=(docker compose --project-name "$project" --env-file "$fixture_dir/fixture.env"
  -f "$task_root/infra/docker-compose.prod.yml" -f "$fixture_dir/override.yml")
cleanup() {
  local result=$?
  trap - EXIT
  "${compose[@]}" logs --no-color --tail 300 > "$fixture_dir/evidence/compose.log" 2>&1 || true
  # Explicit project + non-external, project-scoped volumes only; hosted runner guard above.
  "${compose[@]}" down --volumes --remove-orphans > /dev/null 2>&1 || true
  rm -f "$fixture_dir/license/leadprocure.license" "$fixture_dir/license-fixture.json" "$fixture_dir/fixture.env" "$fixture_dir/browser-account.json"
  rm -f "$fixture_dir/tls/ca.key" "$fixture_dir/tls/server.key"
  exit "$result"
}
trap cleanup EXIT
"${compose[@]}" config --quiet
for service in minio api web ai-orchestrator; do
  "${compose[@]}" build "$service"
done
docker run --rm -i --entrypoint node "leadprocure-acceptance-api:$GITHUB_RUN_ID" \
  < "$task_root/scripts/acceptance/fresh-install-fixture.cjs" > "$fixture_dir/license-fixture.json"
python3 <<'PY'
import json, os
from pathlib import Path
p=Path(os.environ['FRESH_FIXTURE_DIR'])
with (p/'fixture.env').open('a') as f:
 f.write('LICENSE_PUBLIC_KEY_B64='+json.loads((p/'license-fixture.json').read_text())['publicKey']+'\n')
PY
"${compose[@]}" up -d --no-build --wait --wait-timeout 420
for attempt in $(seq 1 120); do
  if curl -fsS http://127.0.0.1:39300/health > "$fixture_dir/evidence/missing-license.json"; then break; fi
  sleep 2
done
python3 <<'PY'
import json, os
from pathlib import Path
p=Path(os.environ['FRESH_FIXTURE_DIR'])
h=json.loads((p/'evidence/missing-license.json').read_text())
assert h['licenseSource']=='missing' and h['licenseStatus']=='expired_restricted', h
(p/'license/leadprocure.license').write_text(json.loads((p/'license-fixture.json').read_text())['token'])
print('Production boot without a license: restricted (PASS)')
PY
"${compose[@]}" restart api
for attempt in $(seq 1 120); do
  if curl -fsS http://127.0.0.1:39300/health > "$fixture_dir/evidence/signed-license.json"; then break; fi
  sleep 2
done
curl -fsS --cacert "$fixture_dir/tls/ca.crt" https://api.leadprocure.test:39443/health > /dev/null
NODE_EXTRA_CA_CERTS="$fixture_dir/tls/ca.crt" \
  FRESH_BROWSER_ACCOUNT_FILE="$fixture_dir/browser-account.json" \
  FRESH_EVIDENCE_FILE="$fixture_dir/evidence/http-acceptance.json" \
  node "$task_root/scripts/acceptance/fresh-install-check.cjs"
FRESH_BROWSER_ACCOUNT_FILE="$fixture_dir/browser-account.json" \
  FRESH_BROWSER_RESULTS_DIR="$fixture_dir/evidence/browser-results" \
  FRESH_BROWSER_EVIDENCE_FILE="$fixture_dir/evidence/https-browser.json" \
  pnpm --filter web exec playwright test --config fresh-acceptance/playwright.config.ts
# Verify the actual fresh-init runtime role and no-context default-deny at DB level.
"${compose[@]}" exec -T postgres sh -c 'PGPASSWORD="$APP_DB_PASSWORD" psql -h 127.0.0.1 -U app_user -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At' <<'SQL' > "$fixture_dir/evidence/role-isolation.txt"
SELECT CASE WHEN NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb THEN 'app_role_restricted=PASS' ELSE 'FAIL' END FROM pg_roles WHERE rolname=current_user;
SELECT 'no_context_budget_rows=' || count(*) FROM budgets;
SQL
python3 <<'PY'
import os
from pathlib import Path
s=(Path(os.environ['FRESH_FIXTURE_DIR'])/'evidence/role-isolation.txt').read_text().splitlines()
assert s==['app_role_restricted=PASS','no_context_budget_rows=0'], s
print('Fresh database role and no-context RLS: PASS')
PY
# Model an existing legacy volume separately; never touch an operator volume.
curl -fL --retry 3 --connect-timeout 15 -o "$fixture_dir/legacy-minio" \
  https://github.com/minio/minio/releases/download/RELEASE.2025-09-07T16-13-09Z/minio.linux-amd64.RELEASE.2025-09-07T16-13-09Z
echo "7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f  $fixture_dir/legacy-minio" | sha256sum -c -
chmod 755 "$fixture_dir/legacy-minio"
"${compose[@]}" up -d --no-build --wait --wait-timeout 120 legacy-storage
STORAGE_UPGRADE_BASELINE="$fixture_dir/evidence/storage-upgrade-baseline.json" \
  node "$task_root/scripts/acceptance/storage-upgrade.cjs" seed
"${compose[@]}" stop legacy-storage
"${compose[@]}" up -d --no-build --wait --wait-timeout 120 upgraded-storage
STORAGE_UPGRADE_BASELINE="$fixture_dir/evidence/storage-upgrade-baseline.json" \
  STORAGE_UPGRADE_EVIDENCE="$fixture_dir/evidence/storage-upgrade.json" \
  node "$task_root/scripts/acceptance/storage-upgrade.cjs" verify
