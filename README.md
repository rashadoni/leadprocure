# Leadprocure

Procurement & tender SaaS for the Azerbaijan market, built to international standards
(UNCITRAL Model Law on Public Procurement 2011, OCDS, Peppol-shaped e-invoicing, ISO 20400).
One codebase serves both **cloud multi-tenant SaaS** and **self-hosted on-premise** deployments
with renewable offline-verifiable licenses (PASETO v4.public / Ed25519).

## What it does

**Buyer cabinet (10 sections):** dashboard (KPIs + savings + task feed) · procurement requests
with value-banded multi-step approval chains · sourcing (sealed RFQ 🔒 and reverse auction ⚡
with anti-sniping, multi-lot partial award, Q&A with equal disclosure, 🤖 explainable AI award
recommendation) · contracts → purchase orders · invoices with 3-way match · digital catalogs
with agreed prices (instant re-order) · logistics tracking · supplier registry + scorecards ·
KYC verification · org settings (users/roles/policies).

**Supplier portal (6 sections):** open tenders (sealed bids are AES-256-GCM-encrypted until the
opening ceremony; the buyer physically cannot see amounts early) · orders in progress with
shipment tracking · contracts · invoicing · catalogs · verification.

**Compliance spine:** append-only hash-chained audit of every state transition, OCDS release
export, Peppol BIS 3.0-shaped UBL invoice export, e-signature seam (ASAN İmza-ready),
integer-minor-unit money with VAT (ƏDV 18%) and multi-currency, az/ru/en i18n.

## Architecture

pnpm monorepo: **NestJS** modular monolith (bounded contexts) + **PostgreSQL 16** with a hybrid
**RLS + ACL** isolation model (buyer-private tables row-locked by org; the shared marketplace
governed by invitation/relationship policies; counterparty writes go through audited
`SECURITY DEFINER` seams) + **React/Vite** SPA + a separate **FastAPI AI Orchestrator**
(LLM rationale via Claude when `ANTHROPIC_API_KEY` is set; transparent weighted heuristic
otherwise; the app falls back to a local scorer if the service is down).

Key design docs: [AGENTS.md](AGENTS.md) (conventions + state), [ROADMAP.md](ROADMAP.md)
(feature design record), [SECURITY.md](SECURITY.md) (audit), [infra/DEPLOY.md](infra/DEPLOY.md).

**Новичку: [docs/DEMO.md](docs/DEMO.md)** — тур по продукту за 10 минут (логины,
жизненный цикл закупки, кто что может). Наполнить стенд демо-историей:
`node scripts/demo-fill.mjs http://localhost:3000`.

## Quickstart (dev)

```bash
docker compose -f infra/docker-compose.yml up -d     # postgres :55440, minio, clamav
cp -n .env.example .env
pnpm install && pnpm build:shared
pnpm --filter api migration:run && pnpm --filter api seed
pnpm --filter api start:dev                          # API  → http://localhost:3000
pnpm --filter web dev                                # SPA  → http://localhost:5173
```

Demo logins (password `Passw0rd!`): buyer `admin@acme.test` / `approver@acme.test` /
`user@acme.test`; suppliers `seller@supply-one.test`, `seller@baku-metal.test`.

## Tests

```bash
pnpm --filter api test:e2e   # 86 API e2e tests (9 suites) + Playwright UI smoke
pnpm --filter web test:ui   # browser smoke: every section of both panels + key flows
```

The suite is the security net: cross-tenant isolation, sealed-bid secrecy before opening,
auction decrement/anti-sniping rules, PO/invoice state machines, RLS policy regressions.
(Stop the dev API first — its connection pool competes with the test apps.)

## Production / on-premise

See [infra/DEPLOY.md](infra/DEPLOY.md) — `docker-compose.prod.yml` builds api, web (nginx),
AI orchestrator, postgres, minio, clamav. Licenses are issued with
`pnpm --filter api license:gen` (vendor side) and installed via `POST /admin/license`;
expiry degrades gracefully (running tenders are never cut off mid-procedure).
