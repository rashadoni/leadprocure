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

ClamAV is not a permanently running service. `leadprocure-av-scan` is a bounded
Cloud Run Job with its own scanner image: it refreshes signatures, starts a local
`clamd`, processes at most 100 `PENDING` objects, and exits. Upload confirmation
requests the job only after the database transaction commits. A low-frequency
Cloud Scheduler catch-up execution covers transient Jobs API failures.

With `CLAMAV_ENABLED=true`, document, bid and supplier-verification downloads
fail closed unless `av_status=CLEAN`. The scanner verifies object size and SHA-256
before ClamAV. Infected files become `INFECTED`; integrity failures become `ERROR`;
objects beyond the 24 MiB stream limit become `SKIPPED`. All three non-clean
states remain blocked. Scanner errors leave the object `PENDING` for retry.

The scanner runtime uses the application database credential and only the
`SECURITY DEFINER` queue/verdict seams. It never receives the owner credential.
An advisory lock ensures overlapping job executions do not process the queue in
parallel. Signature refresh fails closed when the baked database is older than
seven days.

## Verified release order

1. Run `cloudbuild-test.yaml` against an ephemeral PostgreSQL database.
2. Build immutable API, web and AI images tagged with the source commit.
3. Point `leadprocure-migrate` at the new API image, execute it once, then
   execute it again and require `No migrations are pending`.
4. Build `cloudbuild-scanner.yaml`, update `leadprocure-av-scan`, and execute it
   once against an empty queue. Keep one task, one execution worker, and a 2 GiB
   memory cap.
5. Update the services without changing their secret bindings. Keep the
   service-level scaling limits at `min=0, max=1`.
6. Verify `/health`, login/refresh, one protected read, a clean and EICAR
   presigned GCS flow, pending/infected download denial, SHA-256 integrity, AI
   internal-token auth, and `cloudbuild-live-ui.yaml`.
7. Verify the Hetzner `leadprocure-prod-*` rollback stack is still healthy.

Do not deploy automatically from an arbitrary dirty checkout. The pilot branch
is `codex/cloud-run-pilot`; merge or change the production source branch only
after the owner approves the cutover.
