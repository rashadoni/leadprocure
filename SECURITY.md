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
| HIGH | No rate limiting → `/auth/login` brute-force + argon2 CPU-DoS | `@nestjs/throttler`: global 300/min, `/auth/login` 10/min. Verified: 11th rapid login → 429. |
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
- **List pagination**: `requests`/`events`/`contracts`/`orders` lists are RLS-scoped (bounded
  by tenant data) but unpaginated; add limits/paging before large tenants.
- **App DB user privileges**: confirm `app_user` has no DDL and cannot create the bid master
  key material; rotate the demo DB password off `app_pass`.
