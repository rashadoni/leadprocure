# AGENTS.md — Leadprocure (handoff for Codex)

Procurement/tender SaaS. Market: **Azerbaijan**, built to **international standards** (UNCITRAL, OCDS, Peppol, ISO 20400). Stack: **NestJS + TypeScript** (modular monolith), **PostgreSQL 16** (RLS + ACL hybrid), **React + Vite** SPA. Monorepo via **pnpm workspaces**.

Full design plan (deep detail): `~/.claude/plans/mossy-nibbling-badger.md` (v2). This file is the working brief — follow it exactly so new code matches what already exists.

---

## 1. Current state — DONE and VERIFIED (do NOT rebuild)

- Monorepo: `apps/api` (Nest), `apps/web` (Vite — not started yet), `packages/shared` (domain enums/types), `infra/` (docker-compose).
- **DB schema**: one migration `apps/api/src/common/db/migrations/1720000000000-init.ts` created ALL tables + enums + RLS/ACL policies + append-only audit trigger + app_user grants. **It has already run.** Add NEW migrations for changes; never edit the applied one.
- **RLS verified**: owner org sees its rows, other org sees 0, no-context sees 0 (default-deny).
- **Identity** (`src/modules/identity`): register buyer/supplier, login, refresh (httpOnly cookie), `/auth/me` — verified over HTTP.
- **License** (`src/common/license`): PASETO v4.public verifier, `EntitlementService` (dev fallback = enterprise/all-features when no license), `QuotaService`, `FeatureGuard`, `/me/entitlements`, `/admin/license`.
- **Core plumbing** (`src/common`): `AppConfig`, `RequestContextService` (ALS), `TransactionInterceptor`, `DatabaseModule`, `AuditService`, auth guards/decorators, `TokenService`.
- **Regression harness (27 e2e tests, all green)**: `apps/api/test/rls-acl.e2e-spec.ts` (hostile DB-level isolation: RLS, ACL visibility, sealed-before-opening, forged-row rejection, append-only audit) + `test/auth.e2e-spec.ts` (API auth flow). **Run `pnpm --filter api test:e2e` after EVERY module you build and keep it green** — this suite is the security net; extend it (don't weaken it) when adding features.
- Second migration `1720000000001-fix-invitation-policy-recursion.ts` (applied): broke the `sourcing_events ↔ event_invitations` policy cycle via a `SECURITY DEFINER` helper `is_invited_supplier(uuid)` and tightened invited-supplier visibility (no DRAFT/CANCELLED leakage).

## 2. How to run

```bash
docker compose -f infra/docker-compose.yml up -d          # postgres (+minio +clamav)
cp -n .env.example .env
pnpm install
pnpm rebuild argon2 esbuild                                # if native build was skipped
pnpm build:shared
pnpm --filter api migration:run
pnpm --filter api start:dev                                # http://localhost:3000
```

**Env quirks (important):**
- Postgres runs on host port **55440** (5432 = local Homebrew PG, 5433 = an SSH tunnel — both taken). See `.env`.
- Two DB roles: `leadprocure_owner` (`DATABASE_OWNER_URL`, migrations/seed only) and `app_user` (`DATABASE_URL`, runtime — **RLS enforced**, NOBYPASSRLS, not table owner).
- `.env` lives at repo root; `loadRootEnv()` (`src/common/config/env.ts`) walks up to find it, so CLI scripts work regardless of cwd.
- `package.json > pnpm.onlyBuiltDependencies` allows argon2/esbuild native builds.
- `BID_MASTER_KEY_B64` = base64 32-byte key for sealed-bid envelope encryption.

## 3. Architecture rules — FOLLOW THESE (this is what to "account for")

1. **Data access = raw parameterized SQL via the request manager.** In every request-handling service, inject `RequestContextService` and use `this.rc.manager.query(sql, params)`. The `TransactionInterceptor` already opened a transaction on the `app_user` connection and set `app.actor_id / app.org_id / app.role` (the GUCs backing RLS). **Never** create your own `QueryRunner` or use the `DataSource` directly inside a request — that bypasses the RLS context. (Boot-time/global code like `EntitlementService.onModuleInit` may use the injected `DataSource` directly; those touch non-RLS global tables only.)
2. **Services return plain values**, not Observables. The interceptor turns the handler into a promise and re-wraps it. Throw Nest `HttpException`s on error → the transaction rolls back automatically.
3. **RLS is already enforced by the DB.** Private buyer tables filter by `owner_org_id/buyer_org_id = app.org_id`. Shared sourcing tables (`sourcing_events`, `event_*`, `bids`, `bid_*`, `awards`, ...) have ACL-delegating policies — a supplier sees an event only if it's PUBLIC+published or they're in `event_invitations`; a buyer sees only their own; sealed amounts are hidden until opening. **Do not add app-level "special case" bypasses** — rely on the policies; if you need a new visibility rule, add a policy in a new migration. **Policy-cycle rule:** if a new policy on table X must reference table Y and Y's policies reference X (directly or transitively), Postgres fails with "infinite recursion detected in policy" — break the cycle with an owner-owned `SECURITY DEFINER` helper function (pattern: `is_invited_supplier()` in migration `…0001`), never by weakening app_user constraints.
4. **Registration elevates context**: after creating the owning org, call `rc.setOrg(orgId, role)` before inserting owner-scoped (RLS) rows. See `identity.service.ts`.
5. **Money = integer minor units (`bigint`) + `currency` (char 3). Never float.** Compute all totals server-side. VAT via `vat_mode` (INCLUSIVE/EXCLUSIVE) + `vat_rate_bp` (basis points, AZ default 1800 = 18%). Multi-currency: bids carry `currency`+`fx_rate`+`fx_date`; evaluation converts to `sourcing_events.evaluation_currency`; lock fx at award.
6. **Sealed bids**: encrypt the financial payload (unit prices + total) with **AES-256-GCM** — per-event data key wrapped by `BID_MASTER_KEY_B64` — and store `ciphertext/iv/wrapped_key` in `bid_sealed_payloads`. **Do NOT** populate `bids.total_minor` or `bid_items` (cleartext amounts) until the **opening ceremony**. RLS hides these from the buyer until `sourcing_events.status IN (OPENING, EVALUATION, AWARDED)`; the service must also refuse to decrypt/return before opening.
7. **Deadlines are server-authoritative** (UTC; use DB `now()` / `new Date()` — never trust client time). A `@Cron` job flips `OPEN → CLOSED` at `close_at`; bids arriving after → state `LATE` (excluded).
8. **Append-only audit** on every state transition: `auditService.record(action, entityType, entityId, payload)`. Add new actions to `AUDIT_ACTIONS` in `packages/shared` as needed.
9. **License gating**: before publishing a new event call `entitlements.assertCanCreateNew()` (graceful-degradation: blocks NEW work when expired, but never interrupts live tenders) and `quota.consumeMonthlyEvent(orgId)`. Gate premium endpoints with `@RequiresFeature('...')` (e.g. reverse auction — keep the seam, feature deferred).
10. **Guards/decorators**: `@Public()` for unauthenticated routes; `@Roles(...)` (BUYER_ADMIN/BUYER_APPROVER/BUYER_USER/SUPPLIER_USER); `@RequiresFeature(key)`; `@CurrentUser()` → `AccessTokenPayload {sub, org_id, org_kind, role, token_version}`; `@OrgId()`.
11. **Shared vocabulary** lives in `packages/shared/src/index.ts` (enums + types + feature keys). Import from `@leadprocure/shared`; run `pnpm build:shared` after editing it.
12. **New module checklist**: create `src/modules/<name>/{dto.ts, <name>.service.ts, <name>.controller.ts, <name>.module.ts}`, then **add it to `src/app.module.ts` imports** (I removed the not-yet-built `SuppliersModule/RequestsModule/SourcingModule` imports — re-add each as you build it).

## 4. Data model (already migrated — use as-is)

Read `1720000000000-init.ts` for exact columns. Key tables: `organizations`(+`identity_origin`), `organization_users`, `memberships`, `sessions`, `supplier_profiles`, `buyer_profiles`, `supplier_relationships`, `procurement_method_policies`, `procurement_requests`, `request_items`, `sourcing_events`, `event_lots`, `event_items`, `event_invitations`, `event_qna`, `bids`, `bid_sealed_payloads`, `bid_items`, `evaluations`, `evaluation_scores`, `awards`, `documents`, `notifications`, `audit_events`, `fx_rates`, `idempotency_keys`, `licenses`, `entitlement_usage`, `release_versions`.

## 4b. PHASE 2 — DONE (do not rebuild)

All four blocks are built, tested (58/58 e2e across 4 suites) and committed:
- **A. Contracts+POs** (migration 0003): cross-org RLS via denormalized party columns; `po_apply_status()` SECURITY DEFINER is the ONLY status-transition path. UI: Contracts page, supplier "Заказы в работе".
- **B. Dashboard+notifications**: `GET /dashboard/buyer` (RLS-scoped KPIs + task feed), Dashboard page.
- **C. Reverse auction + Q&A** (migrations 0004–0006): append-only `auction_bids` ledger; anonymous best via `auction_state()`; bid path uses `pg_advisory_xact_lock` (suppliers cannot FOR UPDATE events under RLS!) and `auction_try_extend()` for anti-sniping; Q&A equal-disclosure policies. UI: AuctionPanel, QnaCard.
- **D. Settings + scorecards** (migration 0007): org users/roles (anti-escalation: not self, admin-only, token_version bump), `supplier_scorecard_entries`. UI: Settings page, ★ on suppliers registry.

Key gotchas learned (respect these): FOR UPDATE requires UPDATE policies under RLS → suppliers must serialize via advisory locks; owner-run SECURITY DEFINER functions are the sanctioned RLS bypass seam; org FKs must be ON DELETE CASCADE; two jest runs against one DB interfere — run the suite once.

## 4c. PHASE 3 (started) + hardening — DONE

- **Security audit** (`SECURITY.md`): no RLS bypass / no SQL injection / sealed-bid
  integrity confirmed. Fixes applied & verified live: `@nestjs/throttler` (global 300/min,
  login 10/min), `helmet`, CORS `WEB_ORIGIN` allow-list, documents download `@Param` fix.
- **AI scoring** (`common/ai/ai-scorer.ts`): `AiScorer` provider seam + `HeuristicScorer`
  (explainable weighted ranking + reliability index from scorecards). `GET /events/:id/ai-recommendation`.
  Phase-3 swap = FastAPI AI Orchestrator (LLM + pgvector) behind the same interface.
- **Logistics** (migration 0008, `modules/logistics`): `shipments` + `shipment_events`,
  cross-org RLS; milestones walk the PO chain via per-step SAVEPOINTs (best-effort sync).
- Tests: **61/61** across 4 suites. New RLS gotcha: a SECURITY DEFINER function that
  RAISEs inside the request tx aborts it — wrap best-effort calls in SAVEPOINT/ROLLBACK TO.

## 4d. ROADMAP groups 1–4 — DONE

All functional roadmap blocks are built and green (**134 e2e, 16 suites**):
- **Group 1**: bid attachments (mig 0011, cross-org, buyer-after-opening), goods
  receipt/GRN (0012, partial→auto-accept), multi-lot award (per-lot totals),
  multi-step approval (0013, value-banded chains).
- **Group 2**: catalogs + agreed-price matrix (0014, from-contract seed, MOQ,
  instant order→PO), feature `contracts.catalog`.
- **Group 3**: supplier verification/KYC (0015), feature `suppliers.verification`.
- **Group 4**: P2P invoices + 3-way match + pay (0016, DEFINER `invoice_set_status`),
  feature `p2p.invoicing`.
- Cross-org notifications via `app_notify` DEFINER (0010); DIRECT purchase→PO.
- **Budgets & commitment control** (0018, feature `controls.budgets`): private buyer table,
  encumbrance model — APPROVED requests commit against a matching budget (category + year +
  currency); utilization derived, not stored. Soft/non-blocking: request approval attaches
  `budgetWarnings` but never blocks. UI `/buyer/budgets`.
- **Spend analytics** (`GET /dashboard/spend-analytics`, buyer roles): spend = ACCEPTED POs;
  zero-filled 12-month series (generate_series), category via PO→contract→event→request
  (direct POs = uncategorized), top-5 suppliers, per-event tender savings, invoice
  paid/outstanding. UI `/buyer/analytics`, hand-rolled CSS bars (no chart lib).
- **PO amendments / change orders** (0019): buyer proposes per-line qty/price changes on an
  ISSUED/CONFIRMED PO (no GRN yet, one PROPOSED per PO — partial unique index); supplier
  decides via SECURITY DEFINER `po_amendment_decide()` which applies lines + recomputes the
  PO total atomically. `changes` jsonb snapshots old→new so history survives PO mutation.
  UI: propose form on buyer Contracts, diff+accept/reject panel on supplier Orders.
- **RFI/RFP event types** (no migration — enum existed): `createFromRequest` takes
  `type` (default RFQ). RFP = prices + required `proposalText` sealed TOGETHER in the
  bid payload, revealed only at opening, then normal evaluate/award. RFI = response text
  only (no priced items, bids.total_minor stays NULL); terminal state reuses EVALUATION
  ("responses opened"); evaluate/award/aiRecommendation all reject RFI. detail() decrypts
  payloads to attach `proposal_text` to buyer bids ONLY once amounts_visible.
- **Auth gotcha — JWT needs jti.** With 1-second iat resolution, a refresh rotation in the
  same second as issuance produced an IDENTICAL token (rotation = silent no-op, flaky
  auth e2e). TokenService.signRefresh now adds a random jti to every refresh token.
- **Section guides**: floating video-thumbnail widget + spotlight tour on every section
  (components/Guide.tsx + guides.ts route→guide map; videos in web/public/guides,
  re-recorded by scripts/record-guides.mjs against a demo-filled stand). Recorder uses
  ONE browser context per role — reusing a static storageState across contexts replays a
  rotated refresh token and trips the token-reuse breach detection (by design).
- **Email loop**: notifyOrg queues an email fan-out via `rc.onCommit()` — a post-commit
  queue on the request context flushed by TransactionInterceptor ONLY after commit
  (rolled-back actions never send mail). NotifyEmailer mails the recipient org's ACTIVE
  users (cap 50) on its own DataSource connection; body fields come from a WHITELIST
  (po_no/invoice_no/status/title/no) so sealed amounts can't leak into outbound mail.
  Console provider when SMTP_HOST is empty; real SMTP via env in prod.

**Gotcha learned:** TypeORM `UPDATE … RETURNING` yields `[rows, count]` — never read a
column off it; SELECT the value first (bit us in verification `decide`). Also: stop the
`nest --watch` preview server before running the e2e suite — its connection pool starves
the 9 test apps and makes them time out (looks like failures, is contention).

**Gotcha — writes on the throw path get rolled back.** `TransactionInterceptor` runs each
request in a tx and **rolls back on any thrown error**. So a handler that writes and then
throws (e.g. refresh-token reuse detection revoking the session family, then throwing 401)
has its write undone — the security response becomes a silent no-op. When a write MUST
persist despite the request failing, run it on a separate connection (`this.ds.query(...)`
on the injected `DataSource`, autocommit), not on `this.rc.manager`. See
`IdentityService.refresh` breach-nuke.

**Auth gotcha — rotating refresh needs a reuse-leeway.** Refresh rotation with strict
reuse-detection nukes the session on the *normal* SPA double-refresh race (page reload
loses the in-memory access token → bootstrap via `/auth/refresh`; StrictMode double-mount
+ concurrent 401s present the same cookie twice). `sessions.revoked_at` + a leeway window
(mig 0017) tolerates a replay within `JWT_REFRESH_REUSE_LEEWAY_MS`; only stale reuse trips
the breach nuke. Non-rotation revokes (theft, logout, reset) set `revoked_at = NULL` so
they're never benign-replayable. Client coalesces concurrent refreshes into one promise.

## 5. Remaining work — PHASE 3 remainder (not started)

1. **Suppliers** (`modules/suppliers`): buyer registry of suppliers — list global `supplier_profiles`, invite/approve/block via `supplier_relationships` (RLS by `buyer_org_id`). `@Roles('BUYER_ADMIN','BUYER_APPROVER')` for mutations.
2. **Requests** (`modules/requests`): request CRUD + `request_items`; `submit`/`approve`/`reject`; **server-side total recompute** from items; resolve `procurement_method_policies` (value bands → DIRECT/RFQ/OPEN_TENDER) into `method_resolved`. Audit each transition.
3. **Sourcing** (`modules/sourcing`) — the core:
   - Publish a **sealed RFQ** from an approved request (snapshot `request_items` → `event_lots`/`event_items`; status DRAFT→PUBLISHED→OPEN; set `open_at/close_at`). Gate with `assertCanCreateNew()` + `consumeMonthlyEvent()`.
   - Invitations / PUBLIC visibility.
   - Supplier **sealed bid submit** (+ `bid_items` encrypted into `bid_sealed_payloads`; `bids.state=SUBMITTED`); idempotent via `idempotency_keys`; require signature (see §6).
   - `@Cron` close scheduler (OPEN→CLOSED; late→LATE).
   - **Opening ceremony**: decrypt payloads → populate `bid_items`+`bids.total_minor`, state OPENED, event OPENING→EVALUATION, audit receipt.
   - **Weighted scoring** (`evaluations`/`evaluation_scores`): criteria+weights, compute weighted totals.
   - **Award per lot**: `SELECT … FOR UPDATE` event+bids, one winner per lot (`awards` unique `(event_id,lot_id)`), event AWARDED, audit.
4. **Cross-cutting**: documents (S3/MinIO presigned upload + `ClamAV` scan stub + sha256 + versions), notifications (with `delivered_at`), **WebSocket gateway** (event status / participant count / amounts-after-opening), **OCDS export** endpoint (event→tender, award→award releases), **i18n** az/ru/en.
5. **Signature provider** (§6).
6. **React SPA** (`apps/web`): axios (`baseURL=VITE_API_BASE_URL`, `withCredentials`, in-memory access token, 401→`/auth/refresh`→retry); `BuyerLayout`/`SupplierLayout`; `ProtectedRoute` by role; features requests/sourcing/suppliers; entitlements-aware UI; language switcher.
7. **Seed** (`apps/api/src/seed.ts`, wired to `pnpm --filter api seed`): buyer org `acme` (admin/approver/user), supplier org `supply-one` (user), a method policy, an fx rate. Print passwords.
8. **Tests**: Jest e2e (`test/jest-e2e.json`) — happy path + **isolation** (foreign org can't see request/event/bid) + **"amounts hidden before opening"** + idempotency. Playwright happy-path over the UI.

## 6. Signature (ASAN İmza) boundary

Define `SignatureProvider { sign(payload): Promise<string>; verify(payload, sig): Promise<boolean> }`. Ship a `DevSignatureProvider` (HMAC/hash over canonical payload) now; bind real **ASAN İmza** later (needs operator credentials — external blocker). Require a signature on high-assurance actions: **bid submit, opening, award**; store the signature in the audit payload.

## 7. Verify (end-to-end smoke)

Buyer registers → creates request over threshold → publishes sealed RFQ (lots, deadline) → invites supplier → supplier submits sealed bid (**buyer cannot see amounts before `close_at`**) → deadline → opening → weighted scoring → award winner per lot → OCDS release available → audit hash-chain intact. Negative: other org can't see the request/event/bid.
