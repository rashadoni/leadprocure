# AGENTS.md — Leadprocure (handoff for Codex)

## Порядок доставки — `docs/DELIVERY-ARCHITECTURE.md`

Этот документ главнее всего остального в том, что касается пути изменения до
пользователей, и действует одинаково для Claude, Codex и любых будущих сессий.
Коротко: в `main` только через PR; каждый PR разбирает агент, который его не
писал (`agent-review` — единственная обязательная проверка, своё же ревью не
считается); выкладка — как построена в этом репозитории; перед мержем того, что
увидит пользователь, владельцу показывают короткий список человеческим языком и
ждут «давай».

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

All functional roadmap blocks are built and green (**143 e2e, 17 suites**):
- **Group 1**: bid attachments (mig 0011, cross-org, buyer-after-opening), goods
  receipt/GRN (0012, partial→auto-accept), multi-lot award (per-lot totals),
  multi-step approval (0013, value-banded chains).
- **Group 2**: catalogs + agreed-price matrix (0014, from-contract seed, MOQ,
  instant order→PO), feature `contracts.catalog`.
- **Group 3**: supplier verification/KYC (0015), feature `suppliers.verification`.
- **Group 4**: P2P invoices + 3-way match + pay (0016, DEFINER `invoice_set_status`),
  feature `p2p.invoicing`.
- Cross-org notifications via `app_notify` DEFINER (0010); DIRECT purchase→PO.
- **Procurement-integrity controls** (0020, audit remediation): evaluation criteria are
  LOCKED on `sourcing_events.evaluation_criteria` at creation (never re-weighted after
  opening); `evaluate()` only takes scores; `award()` requires a real evaluation + a
  `justification` when the winner isn't the lot's top-ranked bid or is the sole bid (auctions
  bypass — price competition IS the evaluation); soft-cancel award (`awards.cancelled_at` +
  partial unique index) → re-award; disqualify a bid with a reason; SoD — a request's
  `created_by` can't approve it; DISPUTED invoice → APPROVED needs an override reason
  (rebuilt `invoice_set_status(uuid, invoice_status, text)`); VÖEN validated (10 digits).
  Tests: `integrity.e2e-spec.ts`. Test helper `addApprover()` gives specs a second approver.
- **Budgets & commitment control** (0018, feature `controls.budgets`): private buyer table,
  encumbrance model; utilization derived, not stored. **Superseded in scope by the
  budget-by-department work below — read that before touching anything budget-related.**
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
  (components/Guide.tsx + guides.ts route→guide map). Videos are **per-language**:
  web/public/guides/<key>.<lang>.webm (+ .png poster); the widget builds the URL from the
  active UI language. Produced by scripts/produce-guides.mjs against a demo-filled stand:
  per-SCENE Azure TTS (voices ru-RU-Svetlana / az-AZ-Banu / en-US-Jenny) is measured first,
  each language re-records the UI in that language (addInitScript sets localStorage.lp_lang)
  and holds each block exactly for its narration, then ffmpeg adelay+amix syncs voice to
  footage — length is dictated by the story, never a timer. **Azure, not Google/Gemini,
  because only Azure has an Azerbaijani neural voice.** Producer uses ONE browser context
  per role — reusing a static storageState across contexts replays a rotated refresh token
  and trips the token-reuse breach detection (by design).
- **Email loop**: notifyOrg queues an email fan-out via `rc.onCommit()` — a post-commit
  queue on the request context flushed by TransactionInterceptor ONLY after commit
  (rolled-back actions never send mail). NotifyEmailer mails the recipient org's ACTIVE
  users (cap 50) on its own DataSource connection; body fields come from a WHITELIST
  (po_no/invoice_no/status/title/no/budget/utilization) so sealed amounts can't leak into
  outbound mail. Console provider when SMTP_HOST is empty; real SMTP via env in prod.

## 4e. Budget by department (migs 0028–0033) — DONE

The budget module finance actually uses. Read this before changing anything under
`modules/budgets`, `modules/departments`, or the approval path in `modules/requests`.

- **Departments** (0028) = the "who spends" dimension next to the category's "what is
  bought". Curated per buyer (RLS by `buyer_org_id`, like `procurement_categories`), with
  an optional `parent_id` tree and an `owner_user_id`. `procurement_requests.department_id`
  and `memberships.department_id` (the author's home department, the default on new
  requests). **Every FK into `departments` is ON DELETE SET NULL, never RESTRICT** — orgs
  cascade-delete both departments and requests, and a RESTRICT races that cascade and blocks
  org deletion (which every e2e `afterAll` does). "In use" is a service-level 409; retiring
  (`is_active=false`) is the supported way out, and an inactive department is refused on new
  requests.
- **Periods** (0029): a budget owns an inclusive date RANGE (`period_start`/`period_end`)
  plus `period_type` (YEAR/QUARTER/MONTH). `resolveBudgetPeriod()` in `budgets.module.ts` is
  the ONE place that turns "2026 / Q3" into a range — go through it, never build dates
  inline. `period_year` is kept and back-filled only so the migration could ship ahead of
  the code; dropping it is a later migration.
- **`procurement_requests.approved_at` is the date budgets slice by**, not `created_at`.
  A request raised on 28 Dec and approved on 5 Jan belongs to January. Historic rows are
  back-filled from `updated_at` (approximate — the instant was never stored).
- **One budget per request** (0030) — the core rule. `MATCHED_CTE` picks, for every APPROVED
  request, the single most specific budget: `department+category` → `department` → `category`
  → org-wide (`department_id IS NULL`, `category='*'`). Utilization is a group-by over that
  choice. **Do not go back to "each budget sums its own matches"** — that double-counted
  every spend an org-wide and a department budget both covered. A gist `EXCLUDE` constraint
  (`budgets_no_overlap`, needs `btree_gist`) stops two budgets from covering the same
  (department, category, currency, period); the collision surfaces as a 409 via
  `friendlyConflict()` (23505 = name clash, 23P01 = scope overlap).
  `GET /budgets/unbudgeted` = approved spend that matched nothing.
- **Plan / Commitment / Actual** (0031): `purchase_orders.request_id` links an order to its
  origin (denormalized at creation — the request → event → contract → PO chain BREAKS on
  direct purchases and catalog call-offs, so never derive it at read time). A live PO
  (status not CANCELLED/REJECTED) supersedes the estimate it came from, so commitment and
  actual are mutually exclusive per request. `request_status` has CANCELLED +
  `POST /requests/:id/cancel` (admin, reason mandatory, audited) — the only way to release a
  reserve; refused while live orders exist.
- **Thresholds** (0032, `budget_policies`): `warn_pct` (default 80) notifies via
  `app_notify`; `block_pct` is NULL by default = nothing blocks. When armed,
  `enforceOnApproval()` **throws inside the approval transaction**, so the approval rolls
  back and the request stays SUBMITTED (there is a test for exactly this). A BUYER_ADMIN may
  override with a written reason (audited `BUDGET_BLOCK_OVERRIDDEN`); a blocked attempt is
  NOT audited, because its writes roll back with it. `GET /budgets/impact/:requestId` gives
  the projection before the approve click.
- **Revisions** (0033): `budget_revisions` is an append-only ledger (opening plan + every
  amount change with delta, reason, author). The live amount stays on `budgets.amount_minor`
  — the ledger explains it, it is not the source of truth. Renaming writes no revision.
  Rollover of an unspent remainder = a revision of the TARGET pointing back at the source.
- **Phasing** (0039, `budget_phasing`): a budget may carry one row per month of its period,
  holding that month's share of the plan in basis points, summing to exactly 10000. Pace and
  forecast then answer "are we ahead of the PLAN" instead of "ahead of the CALENDAR" —
  heating lands in winter, so an even proration reads a department as overspending in March
  and comfortable in October, both times wrongly. **No rows = the old even proration**, which
  stays right for genuinely flat spend. Shares are percentages, not amounts, so a revision of
  `amount_minor` cannot leave a phasing that no longer sums to the plan. A department's pace
  is the amount-weighted pace of its budgets, so a phased and a flat plan can sit under the
  same parent and still add up. `PUT /budgets/:id/phasing` replaces the whole set (a partial
  edit would leave shares that do not total 100%); an empty list clears it. Closed periods
  refuse. **Read a `date` column through `to_char`** — the driver returns a Date object, and
  string-slicing that yields "Tue Aug 11", which parses to NaN and silently zeroes the plan.
- **Visibility**: a plain BUYER_USER sees only their home department's budgets; with none
  set, an empty list (never the whole org's plan). See `scopeFor()`.
- **`GET /budgets/rollup`** is the finance headline: plan / commitment / actual per
  department, plus PAID taken from `invoices.department_id` (denormalized at submission, so
  it survives a PO being re-scoped). **Paid is reported beside the others, never summed into
  them** — an invoice settles an order already counted as actual, so adding it would double
  the spend. Each row also carries `elapsedPct` and `paceDeltaPct` (utilization minus
  elapsed): 80% spent is unremarkable in November and alarming in May, and a bare
  utilization number cannot tell them apart. `?current=1` narrows to periods containing
  today, which is the only window pace means anything in. Rows also carry `phased`, so the
  UI can say whether "should be at 58%" came from a plan or from a calendar.
- **Exports**: `GET /budgets/export` is the whole picture for a person (plan, commitment,
  actual, remainder). `GET /budgets/export/1c` is a different file on purpose — one row per
  MONTH per budget carrying only the planned amount, because an accounting system loads a
  plan by period and dimension and already holds the facts. Splitting a procurement-side
  commitment across months would be an invention, not a figure. The last month absorbs the
  rounding remainder so the rows total the plan exactly.
- **Year on year**: every analytics split carries the same window a year earlier
  (`prevTotalMinor`, `deltaMinor`, `deltaPct`), and a key present only in the earlier window
  still returns a row — "we stopped buying this" is precisely what the view exists to show.
  `deltaPct` is NULL when last year was zero; inventing a percentage there would be a lie.
  The window is resolved in JS, not left NULL for SQL to default: the chart used to default
  to the last twelve months while the splits defaulted to all time, and an unbounded
  "previous year" simply means "everything". `YYYY-MM` is normalised to a first-of-month date
  before it reaches Postgres — it cannot cast `'2026-06'::date`, so every windowed request
  used to answer 500.
- **Analytics** (`/buyer/analytics`) splits spend by department off
  `purchase_orders.department_id`, NOT by walking PO→contract→event→request the way the
  category split has to. That chain breaks on direct purchases and catalog call-offs — the
  very spend a department head asks about — which is why the column is denormalized. The
  budget-pace card calls `/budgets/rollup` separately rather than reaching into
  BudgetsService from the dashboard: budgets sit behind `@RequiresFeature('controls.budgets')`
  and going through the controller keeps that licence gate honest.
- **Threshold warnings are addressed** to `departments.owner_user_id` via
  `notify.notifyUser()`, falling back to the whole org only when nobody is named. A budget
  alarm mailed to 40 people is one nobody acts on.
- The dev seed creates IT/OPS departments (with owners), a home department for
  `user@acme.test`, and three deliberately non-overlapping budgets — otherwise the module
  opens empty on a demo stand, which is the one screen finance came to see.
- **Catalog call-offs** are POs with no request behind them. They carry their own
  `department_id` (explicit pick, else the buyer's home department) and are matched by the
  second arm of the CTE, `matched_orders`. They can only be claimed by a **category-agnostic**
  budget (`category = '*'`): a call-off has no procurement category, and an "IT" budget must
  not silently absorb spend nobody classified. Always actual, never commitment. With no
  department they show up in `/budgets/unbudgeted` as `kind: 'ORDER'`.
- **AZN only** (0034, `budgets_azn_only` CHECK): multi-currency budgeting with no FX policy
  was a trap — a foreign budget matched nothing and sat at 0% forever, reading as
  "underspending" instead of "broken". Requests carry no currency in the API, so every
  commitment is AZN by construction. **Orders can still be foreign** (a contract inherits its
  tender's `evaluation_currency`), and the engine handles that explicitly: a foreign order
  does NOT supersede its request's AZN estimate (mixing minor units at face value would
  misstate the budget), and it appears in `/budgets/unbudgeted` with its currency. Nothing
  is converted at a guessed rate, and nothing disappears. Every judgement call is recorded
  in `docs/budget-by-department-decisions.md`.

**Gotcha — the UI smoke logs in ONCE per panel, and must stay that way.** `/auth/login` is
throttled to 10/min (brute-force + argon2-DoS guard), so a `beforeEach` login spends one per
test: at five tests the suite sat one test away from tripping its own security control, and
two consecutive runs tripped it for certain (the failures look like a login timeout, not a
429). Each describe now logs in in `beforeAll` and shares one page in serial mode — sharing
inside ONE context is safe; it is reusing a `storageState` across CONTEXTS that replays a
rotated refresh token and trips the breach detection. Run it with the API and web dev servers
up: `pnpm --filter api start:dev`, `pnpm --filter web dev`, then `pnpm --filter web test:ui`
(browsers first: `npx playwright install chromium`).

**Gotcha — never address form fields by position in the UI smoke.** The old selectors
(`form > input`, `.row > div:nth-child(2) input`) silently stopped matching the moment the
request form grew a field, and a selector that stops matching fails as a timeout, which
reads like a broken app. Form fields carry `data-testid` (`req-title`, `req-category`,
`req-department`, `item-name-N`, …) — use those. Status badges are localized, so assert on
the status CLASS (`.badge` → `/DRAFT/`), never on the text.

**Gotcha — a migration that adds a constraint over pre-existing data must fail loudly.**
0030 pre-checks for overlapping budgets and throws with the offenders named: nothing can
guess which of two same-scope budgets was meant to survive, and a silent skip would leave
the double-counting bug the constraint exists to prevent.

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
