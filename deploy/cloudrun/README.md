# Leadprocure Cloud Run pilot

The pilot keeps compute ephemeral and state external:

- `leadprocure-web`: public SPA, request-based billing, min 0, max 1.
- `leadprocure-api`: public application API, request-based billing, min 0, max 1.
- `leadprocure-ai`: token-protected internal API, min 0, max 1.
- PostgreSQL: dedicated database and roles in Neon for the pilot.
- Documents: private Google Cloud Storage bucket through its S3-compatible XML API.
- Secrets: Google Secret Manager; no owner database credential is attached to the API service.

Migrations are a separate release operation. Set `RUN_MIGRATIONS=true` only in
the migration job, never in the API service. The Hetzner stack remains the
rollback environment until data restore, login, upload/download and AI fallback
tests all pass.

ClamAV is deliberately not deployed as a permanently running Cloud Run service:
`clamd` uses a raw TCP protocol and about 1 GiB of memory. The pilot must keep
`CLAMAV_ENABLED=false` until the event-driven scanner job is deployed and tested.
This is acceptable for an isolated test stand, not for client production.

## Verified release order

1. Run `cloudbuild-test.yaml` against an ephemeral PostgreSQL database.
2. Build immutable API, web and AI images tagged with the source commit.
3. Point `leadprocure-migrate` at the new API image, execute it once, then
   execute it again and require `No migrations are pending`.
4. Update the services without changing their secret bindings. Keep the
   service-level scaling limits at `min=0, max=1`.
5. Verify `/health`, login/refresh, one protected read, a presigned GCS
   upload/download with matching SHA-256, AI internal-token auth, and
   `cloudbuild-live-ui.yaml`.
6. Verify the Hetzner `leadprocure-prod-*` rollback stack is still healthy.

Do not deploy automatically from an arbitrary dirty checkout. The pilot branch
is `codex/cloud-run-pilot`; merge or change the production source branch only
after the owner approves the cutover.
