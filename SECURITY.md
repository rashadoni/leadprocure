# Security audit — Leadprocure (pre-demo)

Manual code audit of `apps/api/src` + `apps/web/src` covering RLS/ACL, sealed-bid
integrity, authz, auction integrity, injection, auth, money, crypto, web, DoS.
(Codex second-opinion pass was out of quota at audit time — rerun when available.)

## Verified correct (no action needed)

- **No RLS bypass in request paths.** Every request-handling query goes through the
  request-scoped transactional manager (`RequestContextService.manager`) with `app.org_id`
  set. The only direct `DataSource` uses are boot-time (`EntitlementService`) and the
  deadline scheduler (`close_due_events()`), which is a `SECURITY DEFINER` seam by design.
- **No SQL injection.** All runtime SQL is parameterized (`$1`…). Only migrations
  interpolate identifiers, and those are constant table/column names, never user input.
- **SECURITY DEFINER functions don't trust caller-supplied identity.** `po_apply_status`,
  `auction_try_extend`, `close_due_events`, `is_invited_supplier`, `auction_state` read the
  actor from `current_setting('app.*')`, not from arguments, and re-check party membership.
- **Sealed-bid integrity holds across every read path.** `detail()` nulls `total_minor`/
  `delivery_days` and omits `bid_items` until `status ∈ {OPENING,EVALUATION,AWARDED}`;
  `ocds` derives from `detail()`; the dashboard/contracts aggregates only touch post-award
  bids. RLS independently hides `bid_sealed_payloads`/`bid_items` pre-opening. Suppliers
  cannot read competitors' `bids` or `auction_bids` rows (RLS scoped to own org).
- **Auction integrity.** Bid path serializes on `pg_advisory_xact_lock`, re-reads best
  under the lock, enforces start-price + min-decrement, rejects post-deadline and
  negative/non-integer prices; anti-sniping extension is bounded. Idempotency key dedups.
- **Money.** Integer minor units end-to-end; totals recomputed server-side from item ×
  qty; client totals ignored. No float arithmetic on money.
- **Crypto (`sealed.service.ts`).** AES-256-GCM, random 12-byte IV per seal, random
  per-bid DEK wrapped by the master key, auth tag appended and verified on open. No IV
  reuse (fresh `randomBytes` each call), no ECB.
- **Auth.** Argon2id hashing; refresh is httpOnly + SameSite=Lax + Secure(from env);
  `token_version` checked on refresh and bumped on role change (kills stale tokens);
  access token in memory only (no localStorage).
- **Role escalation.** `settings.setRole` is admin-only, refuses self-edit, and audits.

## Fixed in this pass

| Sev | Finding | Fix |
|-----|---------|-----|
| HIGH | No rate limiting → `/auth/login` brute-force + argon2 CPU-DoS | `@nestjs/throttler`: `/auth/login` 10/min, 300/min **per route handler** elsewhere. Verified: 11th rapid login → 429; 6th rapid `/auth/forgot-password` → 429 (`access-log.e2e-spec.ts`). **Not a global cap** — `@nestjs/throttler` keys its bucket per route handler *plus client address*, so one client may make 300/min on each of ~160 handlers. Measured 2026-11-10 on acceptance run `42857447484`: 1869 requests in 98 s, peak 1381/min, zero 429 — the busiest single route (`GET /auth/me`) peaked at 214 of its own 300. Those figures are historical: that stand built the SPA with `NODE_ENV: test`, i.e. a development React bundle whose `<React.StrictMode>` runs every effect twice, so every effect-driven route counted double (fixed 2026-11-11, PR #186 — `/auth/me` now peaks at 100 of its 300, and a comparable run totals 1273 requests, not 1874). The conclusion stands either way: 935/min still passes with zero 429, so there is no global cap. A true cap on total request volume is still [Deferred](#deferred-not-blocking-a-controlled-demo-do-before-production). |
| MED | CORS reflected any origin with credentials | `WEB_ORIGIN` allow-list; verified no `Access-Control-Allow-Origin` for unknown origins. |
| MED | No security headers | `helmet()` (CSP, HSTS, nosniff, X-Frame-Options) — verified present. |
| LOW | `documents/:id/download` read `@Query('id')` not `@Param` (broken, not a leak) | switched to `@Param`. |

## Deferred (not blocking a controlled demo; do before production)

- **Set real secrets in prod**: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `BID_MASTER_KEY_B64`
  are `*_change_me` dev defaults. Set `REFRESH_COOKIE_SECURE=true` behind HTTPS. Move the
  bid master key to a KMS.
- ~~**Inline-typed request bodies** aren't class-validated.~~ **DONE** — every `@Body()`
  across all modules (sourcing, contracts, invoices, catalogs, verification, suppliers,
  settings, logistics, documents, license, requests) is now a class-validator DTO: money is
  a non-negative integer, enums use the shared `*_STATUSES`/`MEMBERSHIP_ROLES` sources,
  UUIDs/required fields are enforced, nested item arrays validate per-element, and the global
  `ValidationPipe(whitelist:true)` strips unknown keys. Covered by `validation.e2e-spec.ts`.
- ~~**List pagination**: `requests`/`events`/`contracts`/`orders` lists are unpaginated.~~
  **DONE** — those four now do server-side offset pagination (`?page`/`?pageSize`, clamped
  ≤200) returning a `{ items, total, page, pageSize }` envelope, with a shared `<Pager>` in
  the UI. Covered by `pagination.e2e-spec.ts`. The lower-cardinality lists (suppliers,
  invoices, catalogs, verification, logistics) remain capped at 200 — fine until those grow.
- **No cap on total request volume per client.** `@nestjs/throttler` keys its bucket per
  route handler plus client address, so the 300/min above is a per-handler budget: a client
  may spend 300/min on each of ~160 handlers. Measured 2026-11-10 (acceptance run
  `42857447484`): 1869 requests in 98 s, peak 1381/min, zero 429 — historical numbers, taken
  off a stand that served a development React bundle and so counted every effect-driven route
  twice (PR #186); a comparable run now peaks at 935/min, still with zero 429. The login handles are the
  ones that matter for brute force and they are capped tightly (10/5/10), so this is a
  volume/cost concern rather than an auth one — a reverse proxy limit or a `ThrottlerGuard`
  subclass keyed on the address alone. `scripts/acceptance/api-log-summary.mjs` reports each
  handler's peak against its own limit, and `throttle-limits.e2e-spec.ts` keeps its table
  honest against the decorators.
- **App DB user privileges**: confirm `app_user` has no DDL and cannot create the bid master
  key material; rotate the demo DB password off `app_pass`.
