# Existing-runtime release preparation — 28 October 2026

This is preparation, not deployment authorization or an executable release manifest.
No production container, database, configuration or volume was changed.

## Accepted source and operator routing decision

- Active repository: `rashadoni/leadprocure`.
- Reviewed and merged main: `11c351bb7b82209fb2a25d27b69a3f9ac9cb82d8`.
- Exact-main acceptance: https://github.com/rashadoni/leadprocure/actions/runs/40654892904 (both jobs successful). See `ACCEPTANCE-MAIN-RECONCILED-2026-10-28.json` for scope.
- Owner clarified: keep the **current IP**, not a new domain. Preserve application `http://75.119.156.234:8180`, API host port `3100`, storage host port `9002`. Public API/storage URLs must be read back from current browser/configuration before freezing build arguments.
- This is an interim HTTP route. Public HTTPS acceptance remains NOT RUN; hosted private-CA HTTPS acceptance does not change that fact. Keep the existing HTTP-compatible refresh-cookie setting until a separately selected HTTPS route exists.

## Read-only runtime observations

Project `leadprocure-prod` runs on the same Contabo inspection host; root inspection uses the loopback alias `leadprocure-prod`.

| Service | Current image identity | Existing data / route |
|---|---|---|
| API | `sha256:f44725790f1afe6d249ffdb7aae524b7794e629f557fe90dd6905197fde7fd8c` | `3100:3000`, no mounted license |
| Web | `sha256:da7900fb90e8c9f5166147911e93451b037ebe9aea8bb727f23b525cfa316afe` | `8180:80` |
| PostgreSQL | `sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20` | `leadprocure-prod_pgdata`; no public port |
| MinIO | `sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e` | `leadprocure-prod_minio`, `9002:9000` |
| ClamAV | `sha256:a73435b0fa51886e9e6dd1881656023ba9dce756e055f23981270badbb8ca3d7` | `leadprocure-prod_clamav` |
| AI | `sha256:6ae758c194581326f8204a4b9e3c7308f1b035a011b6aa7715e0e889c07aca6d` | no public port or data mount |

App/DB Compose labels point to `/home/rashad/projects/Leadprocure/.claude/worktrees/budget-by-department-audit-4e2173/infra`; storage/AV/AI labels point to `/home/rashad/projects/Leadprocure/infra`. Both source checkouts contain untracked/dirty material and must remain intact. Container image IDs are rollback references, not externally published release digests.

The running MinIO binary reports `RELEASE.2025-09-07T16-13-09Z`, commit `07c3a429bfed433e49018cb0f78a52145d4bedeb`. This matches the modeled legacy-storage fixture; no actual production-volume upgrade or restore has been accepted.

API configuration was inspected with a whitelist/presence checks only: production/cloud_multi_tenant, current HTTP WEB_ORIGIN, `REFRESH_COOKIE_SECURE=false`, `CLAMAV_ENABLED=true`; DB URLs and bid master key present; license file/public verification key absent; SMTP/Meta secrets absent. No secret values are included here. Earlier read-only DB inspection found zero installed licenses and five historical invoice lines without the new tax snapshots.

No Leadprocure backup was found in the limited directory checks (`/var/backups/leadprocure` absent; direct entries under `/home/rashad/backups` showed `codex-sessions`). This is not an exhaustive backup inventory. No production dump or encryption material has been extracted.

## Concrete release boundary

1. Freeze a single operator-owned release directory and manifest without modifying either existing source checkout. Explicitly preserve existing network/service names and exact named volumes; do not run the fresh-install template blindly against the mixed project. Prefer an app-only release retaining the current DB/storage/AV/AI images; any storage replacement needs its own actual-volume acceptance.
2. Read back public API/storage endpoints and check secret/configuration consistency without printing values. Preserve current DB role passwords, JWT secrets and bid master key; `.env.prod.example` values are not an upgrade configuration.
3. Await the pending owner choice of existing signed license versus an internal license for their own SaaS stand. Do not issue an ephemeral CI license, copy an issuer private key into runtime, or reinstate development fallback. The actual operator instructions are `infra/license/README.md` (the shorter link in `infra/DEPLOY.md` is stale).
4. Prepare SHA-bound API/web artifacts on a hosted build worker with the retained IP build arguments. Existing CI retained evidence, not deployable image archives; production release artifacts remain NOT BUILT. Do not build containers on this persistent host.
5. Select a protected real backup destination and consistent DB/object-storage/configuration capture process. Verify restoration in isolation before migration. `scripts/acceptance/backup-restore.sh` is explicitly guarded for synthetic isolated CI and must not be repurposed against production.
6. Preserve the five historical invoice lines. Migration does not invent historical tax snapshots; legacy export can fail explicitly until its tax policy is established. No data deletion or silent recalculation is part of the release.
7. Review the complete manifest, backup evidence, exact images and rollback procedure; then obtain separate production permission. Merge approvals for PR3–6 and PR7–9 do not authorize deployment.
8. Only after that permission: controlled app stop/migration/start, followed by actual-IP health/license-source, login/refresh/logout, role isolation, approvals, sealed-bid visibility, document upload/download/AV and browser presigned-storage checks. Never seed or reset production. Record migration history and deployed image/source IDs. Forward-only schema changes require a verified data/schema recovery plan; old API images alone are not a database rollback.

The source reconciliation/PR/main-acceptance prerequisite in the earlier `RUNTIME-RECONCILIATION-2026-10-28.md` is completed and superseded by the exact-main evidence above. Its production backup, licensing and historical-data boundaries still apply. External SMTP/Meta acceptance remains unavailable because the owner confirmed no connections exist.
