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

