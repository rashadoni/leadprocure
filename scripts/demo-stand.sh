#!/usr/bin/env bash
# Brings up the disposable DEMO stand, seeds it, fills the demo story, and prints the
# environment the guide recorder needs. Everything it creates is named `leadprocure-demo-*`
# and is meant to be destroyed afterwards.
#
# NEVER on Contabo and never anywhere near production: this is a heavy run (a Docker image
# build plus a browser afterwards), and `infra/DEPLOY.md` forbids demo seed/reset against a
# production database. `scripts/demo-target.mjs` refuses any target that is not this exact
# labelled disposable stack, which is the mechanical half of the same rule.
#
#   bash scripts/demo-stand.sh            # up + seed + fill, then print the recorder env
#   bash scripts/demo-stand.sh down       # destroy the stand and its volumes
#
# Prerequisites on the machine that runs it: Docker, Node 20+, pnpm 10.33.4, and
# `pnpm install --frozen-lockfile` already done in the checkout (the recorder loads
# Playwright from apps/web/node_modules).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT=leadprocure-demo
COMPOSE=(docker compose -p "$PROJECT" -f "$ROOT/infra/docker-compose.demo.yml")

# These four are the contract demo-target.mjs checks. Exported here so the seed, the fill
# and the recorder all agree, and so a stray value cannot slip in from a shell profile.
export DEMO_ISOLATED=1
export DEMO_PG_CONTAINER=leadprocure-demo-pg
export DEMO_API_CONTAINER=leadprocure-demo-api
export DEMO_API=http://127.0.0.1:3200
WEB_URL=http://localhost:5173

if [ "${1:-up}" = "down" ]; then
  "${COMPOSE[@]}" down --volumes --remove-orphans
  echo "✓ demo stand destroyed"
  exit 0
fi

echo "→ building and starting the stand (first run builds the API image — minutes, not seconds)"
"${COMPOSE[@]}" up -d --build --wait --wait-timeout 600

# WAIT FIRST, SEED SECOND — the order is the whole point. The API entrypoint applies the
# migrations and only then starts serving, so "the API answers" is the only cheap proof
# that the schema exists. Seeding before that fails with
# `relation "organization_users" does not exist`, which reads like a broken migration and
# is really just a race. The compose healthcheck says the same thing to `--wait`; this
# loop stays because a healthcheck can be edited away and the cost here is one curl.
echo "→ waiting for the API to answer on $DEMO_API (migrations run at its boot)"
for i in $(seq 1 90); do
  if curl -fsS "$DEMO_API/health" >/dev/null 2>&1; then break; fi
  if [ "$i" = 90 ]; then
    echo "✗ API never answered on $DEMO_API — its log says why:" >&2
    "${COMPOSE[@]}" logs --tail 40 leadprocure-demo-api >&2
    exit 1
  fi
  sleep 2
done

# Separate from the migrations: this creates the orgs, the users and the method policy the
# demo story is then built on top of.
echo "→ seeding base accounts (orgs, users, method policy, fx rate)"
"${COMPOSE[@]}" exec -T leadprocure-demo-api pnpm --filter api seed

# DEMO_LANG=az: the story's titles are what the Azerbaijani scenarios click by name
# ("Tender: noutbuk və monitorlar", "Auksion: ofis kağızı"). Seeded in another language,
# those clicks miss and the scenes play over a motionless screen.
echo "→ filling the demo story in Azerbaijani"
DEMO_RESET=1 DEMO_LANG=az node "$ROOT/scripts/demo-fill.mjs" "$DEMO_API"

cat <<EOF

✓ stand up: API $DEMO_API · web (start it yourself) $WEB_URL

Next, in two more terminals:

  1) the web front — the API address is baked at BUILD time, so it must be passed here:
     VITE_API_BASE_URL=$DEMO_API pnpm --filter web dev

  2) the recording (needs AZURE_SPEECH_KEY/REGION for en and GEMINI_API_KEY for az/ru):
     DEMO_ISOLATED=1 \\
     DEMO_PG_CONTAINER=$DEMO_PG_CONTAINER \\
     DEMO_API_CONTAINER=$DEMO_API_CONTAINER \\
     DEMO_API=$DEMO_API \\
     node scripts/produce-guides.mjs $WEB_URL az

     Add FORCE=1 to re-record sections whose file already exists — without it the
     recorder SKIPS them, which is the resume behaviour and not what a re-shoot wants.
     Add RESEED=1 to have the recorder re-fill the story itself before each language.

When you are done: bash scripts/demo-stand.sh down
EOF
