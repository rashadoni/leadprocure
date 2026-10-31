# Deploy — isolated acceptance and separately authorized release

The active repository is `rashadoni/leadprocure`. Changes reach `main` through a
reviewed PR, following `docs/DELIVERY-ARCHITECTURE.md`. A passed CI run is not
permission to deploy. Preserve the existing dirty Contabo runtime checkout. Do not
copy a feature worktree over it or rebuild it without a separate release decision,
routing check, preflight and verified backup.

## Fresh installation configuration

Use an empty, explicitly selected project on an amd64 build/test worker first.
Full source/container builds do not belong on the persistent Contabo editing host.
Results and remaining limits are recorded in
`docs/audits/datasheet-2026-10-26/STATUS.md`; the revised source-built storage path
is not accepted until its hosted CI evidence is present there.

```bash
cd infra
cp .env.prod.example .env.prod
# Edit .env.prod; never commit it or print resolved Compose configuration.
openssl rand -hex 24      # separate owner and app database passwords
openssl rand -base64 48   # separate JWT_ACCESS_SECRET and JWT_REFRESH_SECRET
openssl rand -base64 32   # BID_MASTER_KEY_B64; preserve it across upgrades
```

Database passwords are embedded in connection URLs: the suggested hexadecimal
values avoid URL-reserved characters. On an **empty volume**, `01-roles.sh`
creates `app_user` from `APP_DB_PASSWORD`, with no superuser/BYPASSRLS privileges,
and uses the configured owner/database names. On existing volumes it does not run:
keep the actual existing password; changing env does not rotate a DB role.

Every `NODE_ENV=production` installation needs a signed license, including SaaS.
Put the issuer's public verification key (base64 PEM) in `LICENSE_PUBLIC_KEY_B64`.
Create the operator-owned `LICENSE_DIR` and put `leadprocure.license` there. The
directory is mounted read-only into the API and must already exist. **Never ship
the issuer's private key.** Missing/invalid licenses produce restricted health
status; no development fallback is available in production. Commercial client
licensing and renewal remain separate acceptance steps. See `infra/license/README.md`
from the repository root.

Set HTTPS `WEB_ORIGIN`, `PUBLIC_API_URL` and `S3_PUBLIC_URL` to addresses reachable
by the browser. SigV4 binds the storage host: rewriting a signed URL breaks it.
Configure SMTP/Meta only when connections exist; console output does not prove delivery.

There is no `VITE_DEMO_HINT` any more. It gated a line on the login page that printed
seeded logins and their password, this file said to keep it empty, and a production image
was built with it on regardless — so the live login page handed a working supplier
password to anyone who opened it. The line is gone from the code rather than re-guarded.
Credentials for a freshly seeded database come from `pnpm --filter api seed`, which prints
them.

## Build and start a fresh, isolated stand

On the designated build worker:

```bash
docker compose --project-name leadprocure-install-test \
  -f docker-compose.prod.yml --env-file .env.prod build minio api web ai-orchestrator
docker compose --project-name leadprocure-install-test \
  -f docker-compose.prod.yml --env-file .env.prod up -d --no-build --wait
```

The bundled S3 image builds exact archived upstream source revisions instead of
pulling retired MinIO container images. This is a controlled compatibility
snapshot, not a maintained vendor distribution or support SLA. Review storage
maintenance and licensing policy before selecting it for a client; see
`storage/README.md`. Existing MinIO volumes are not proven upgrade-compatible by a
fresh-volume test. Never replace their image or delete data as a workaround.

Bucket initialization is mandatory: it authenticates, creates the bucket and
removes anonymous access. Failure prevents API startup. Do not enable public
bucket reads. API migrations run before application startup. API listens on host
:3000, web :8080 and browser storage :9002; avoid collisions with existing services.
MinIO console :9001 stays internal in this template.

Use a TLS reverse proxy for all three public endpoints. `REFRESH_COOKIE_SECURE`
is enabled; verify cookie/CORS behavior through the actual TLS route. ClamAV must
be healthy with `CLAMAV_ENABLED=true`. The hosted gate targets amd64; historical
Apple Silicon results do not validate the revised stack on arm64.

CI-only `scripts/acceptance/fresh-install.sh` builds and destroys a uniquely named
project on a GitHub-hosted runner. It checks production restriction without a
license, an ephemeral signed file license, budget warnings and role separation,
private presigned storage and real clean/EICAR scans. It never seeds or resets a
production database. **Do not run demo seed/reset in production.**

## Existing installation release

Before an explicitly authorized release, resolve actual Compose project,
working-directory labels, SHA and configuration. Run the read-only SQL preflight;
reconcile historical duplicates without deleting financial records. Back up the
real database, storage and required encryption/configuration material using the
operator's protected process, then verify restoration separately. A disposable CI
dump/restore is not a production backup.

Build the reviewed SHA on the designated worker and use verified release image
digests. Preserve volumes, DB role passwords and the bid encryption key. Migrations
are forward-only; application rollback alone may not reverse a schema change.
Never run an unreviewed `git pull && up --build` against the dirty runtime checkout.
Reconcile the release route and get owner authorization before any mutation.

The opt-in hosted API/web packaging workflow and checksum verification are
documented in `scripts/release/README.md`. It publishes downloadable image archives,
not registry digests, and does not deploy. Existing operator backups may be used
once coverage, freshness and recovery suitability are verified; this does not
require creating a duplicate backup system.

After release, verify health **and license source/status**, role/organization
isolation, procurement approval and sealed-bid visibility, document access/AV,
HTTPS refresh cookies/CORS and absence of demo credentials. Record deployed SHA,
backup/restore evidence, smoke results and rollback point in the session log.
