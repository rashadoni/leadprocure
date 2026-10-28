# Runtime compatibility — 28 October 2026

## Decision

Do not deploy main974a31b directly over the existing Leadprocure runtime. The four authorized PRs are merged and their exact combined main passed acceptance40593765052 and PPTX rendering40593880674. That evidence validates main in isolation; it does not validate replacing the divergent live budgeting implementation.

## Confirmed read-only findings

| Item | Observed state |
|---|---|
| Active owner | rashadoni/leadprocure |
| App source | claude/budget-workflow,400f8616eceb02c8b56993a41adafc99aba70474 |
| Runtime app/DB Compose directory | /home/rashad/projects/Leadprocure/.claude/worktrees/budget-by-department-audit-4e2173/infra |
| Storage/AV/AI Compose directory | /home/rashad/projects/Leadprocure/infra |
| Runtime canonical checkout | main2a94cc5,8 dirty/untracked paths; preserved |
| Runtime app worktree |2 untracked paths; preserved |
| Health | HTTP200, cloud_multi_tenant, enterprise, old licenseStatus=valid without licenseSource |
| Applied schema |40 migration identities, budget0028–0039; audit0028–0034 absent |
| Budgets | period_year removed by0035; main SQL still requires it |
| Preflight data | duplicate invoice lines0; duplicate evaluation criteria0; document/bid/KYC namespace mismatches0 |
| Historical invoice tax |5 lines require explicit historical tax policy; never invent snapshots |
| Signed license |0 installed DB rows, LICENSE_FILE unset; old development-like health is not signed-license evidence |

The old branch has58 commits not in audited main, including department budgets, periods, workflow/finance role, revisions, closed snapshots, monthly phasing and plan/fact. Main has27 commits absent from that branch. Restoring only period_year would not reconcile required period fields, workflow or downstream department/request links. There is no production deployment workflow; actual mixed Compose routing must be reconciled before a separately authorized release.

## Reconciliation candidate

Dedicated branch codex/leadprocure-budget-audit-integration, based on reviewed main974a31b with runtime400f861 source merged, preserves both histories. Applied migration classes/files are unchanged, including overlapping timestamps with different names. Test manifests hash each baseline source file; hosted tests exercise audit-main→combined and budget-runtime→combined independently, with preserved migration records/plan and empty second run. A timestamp overlap is not falsely reported as a duplicate migration-name error.

The candidate preserves department/request/PO/invoice links and budget lifecycle, while retaining audit money/tax/locks, files, licensing and delivery controls. Independent review and native browser checks exposed and corrected budget by-ID/impact scope bypasses, draft budget masking a live limit, competing approvals crossing the same limit, rounded/zero limit decisions, finance API/UI/routing, eligible alternate approver and financial department deletion. Source checkpoints and actual CI outcomes are append-only in docs/budget-audit-integration-session-log.md. The candidate is not accepted merely because main passed earlier.

Runtime guide media was read without modification and verified against committed LFS object hashes before upload to the active rashadoni repository. Imported TTS cache is excluded from the candidate tree with a forward commit; existing history/files remain preserved. No customer records, environment secrets, production license token, DB dump or volume were transferred.

## Release prerequisites that remain separate

1. Review and owner approval for the concrete reconciliation PRs; verify the final merged SHA.
2. Select a single operator-controlled Compose release route, preserving both dirty runtime checkouts and all current configuration/volumes.
3. Obtain a valid signed commercial/runtime license with matching deployment mode and public verification key. Do not generate an ephemeral CI license for production or restore fallback.
4. Protect and back up the real DB, storage, encryption key/configuration through the operator process, and verify restoration separately. Synthetic CI restore is not a production backup.
5. Review5 historical invoice lines for tax export policy without deleting/resumming financial records.
6. Build immutable release images on a designated worker; no full source/container build on persistent Contabo.
7. Only after separate production authorization, run the reviewed upgrade and real-route health/license/role/isolation/sealed-bid/files/HTTPS smoke; record exact release and rollback evidence.

External SMTP/Meta cannot be accepted until configured connections exist (owner confirmed none). Client public TLS/commercial installation, ARM, full capacity/SLA and native desktop PowerPoint remain outside current accepted scope. Nothing in this report grants deploy permission.
