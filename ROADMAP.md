# Leadprocure — functional roadmap

> **STATUS: all blocks below are BUILT and green (85 e2e tests, 9 suites).**
> Group 1 (attachments 0011, GRN 0012, multi-lot, approvals 0013), Group 2
> (catalogs 0014), Group 3 (KYC 0015), Group 4 (P2P invoices 0016) — done.
> This file is kept as the design record. Next candidates: FastAPI AI Orchestrator
> (real LLM), Peppol e-invoicing, on-prem federation, carrier/ERP integrations.



Implementation plan for the un-built functional blocks. **Follow the conventions in
`AGENTS.md` §3** for everything below: raw SQL via `rc.manager`, integer minor units +
server-side recompute, `auditService.record` + `notify.notifyOrg` on state changes,
feature-gating via `@RequiresFeature`, i18n az/ru/en, and a hostile-isolation e2e per block.

**Cross-org access recipe (used by every buyer↔supplier table here):** denormalize BOTH
`buyer_org_id` + `supplier_org_id` onto each row; RLS `SELECT` = either party, RLS write =
the owning party; the counterparty writes through a `SECURITY DEFINER` function (the
`po_apply_status` / `app_notify` pattern). Never join through other RLS tables in a policy
(recursion — see AGENTS.md).

Next migration number: **0011**. Feature keys to add to `packages/shared` `FEATURE_KEYS`:
`contracts.catalog`, `suppliers.verification`, `p2p.invoicing`.

---

## GROUP 1 — finish the tails

### 1a. Attachments in the UI  ·  effort S–M  ·  backend DONE
Backend `/documents` (presign → PUT → confirm, ClamAV seam, sha256) already exists.
- **Infra:** add a one-shot `createbuckets` service to `docker-compose*.yml` (mc) that makes
  the `leadprocure` bucket and sets **CORS** to allow `PUT` from `WEB_ORIGIN` (browser
  presigned upload fails otherwise). Locally: `docker compose up -d minio` + `mc` CORS.
- **Cross-org bid docs:** `documents` is owner-org-only today. For bid attachments the buyer
  must see them after opening → add `bid_documents` (denormalized parties, same gate as
  `bid_items`: buyer visible only when event ≥ OPENING) instead of overloading `documents`.
- **Web:** `<DocUpload entityType entityId>` (file → `crypto.subtle` SHA-256 → presign → PUT →
  confirm → refresh) + `<DocList>` (download via `GET /documents/:id/download`). Wire into
  buyer `EventDetail` (tender spec), supplier `SupplierEvent` (bid files), contracts.
- **Test:** presign+confirm row appears; foreign org can't list it.

### 1b. Multi-lot / partial award  ·  effort M
Model already has `event_lots` + `awards UNIQUE(event_id,lot_id)`; today create-from-request
makes ONE lot. Add: buyer defines lots and assigns `event_items.lot_id` at event creation;
award each lot independently (award endpoint is already per-lot). Sealed/auction bids stay
per-event; scoring/award operate on the lot's `bid_items`. UI: lot grouping on the event page.
- **Test:** two lots, award each to a different bid; event AWARDED only when all lots awarded.

### 1c. Goods receipt (GRN)  ·  effort M
- **Migration 0011:** `goods_receipts`(po_id, buyer_org_id, supplier_org_id, received_by,
  received_at, note) + `goods_receipt_items`(gr_id, po_item_id, qty_received). Cross-org read;
  **buyer** writes (receiving is buyer-side).
- **Logic:** partial receipts allowed; when Σ qty_received ≥ ordered qty for all lines, the PO
  may move to ACCEPTED (through `po_apply_status`). Feeds the 3-way match (Group 4).
- **API:** `POST /orders/:id/receipts {items:[{poItemId, qty}]}`, `GET /orders/:id/receipts`.
- **UI:** "Receive" action on the buyer order with per-line received quantities.
- **Test:** partial then full receipt; over-receipt rejected; foreign org blocked.

### 1d. Multi-step approval workflow  ·  effort L
- **Migration:** `approval_policies`(buyer_org_id, min_amount_minor, max_amount_minor,
  steps jsonb=[{order, role}]) + `approval_steps`(request_id, owner_org_id, step_no,
  approver_role, status, acted_by, acted_at). Private buyer tables (RLS by org).
- **Logic:** `request.submit` materializes steps from the matching policy; `approve` advances
  the current step (guard: caller has that step's role and it's the current step); request →
  APPROVED when the last step completes; any reject → REJECTED. Notify next approver.
- **UI:** approval chain on the request with the current step highlighted.
- **Test:** 2-step chain; wrong-role approve rejected; out-of-order approve rejected.

---

## GROUP 2 — Catalogs + agreed-price matrix  ·  effort M–L
"Instant re-orders without re-tendering" (V3 doc). Feature key `contracts.catalog`.
- **Migration:** `catalogs`(buyer_org_id, supplier_org_id, contract_id?, title, currency,
  status[DRAFT,ACTIVE,ARCHIVED], valid_from/to) + `catalog_items`(catalog_id, buyer_org_id,
  supplier_org_id, name, sku, uom, unit_price_minor, vat_rate_bp, moq). Cross-org read; buyer
  writes (or seed a catalog from an awarded bid: copy `bid_items` → `catalog_items`).
- **Catalog order:** `POST /catalog-orders {catalogId, items:[{catalogItemId, qty}]}` → a PO
  straight away (reuse `purchase_orders`, contract_id from the catalog), prices from the
  catalog. Enforce MOQ; totals recomputed server-side.
- **UI (buyer):** "Catalogs" section — list catalogs/items, a quick-order cart → PO.
- **Test:** catalog from award; catalog order creates a priced PO; MOQ enforced; foreign org
  can't read another buyer's catalog.

---

## GROUP 3 — Supplier verification (KYC)  ·  effort L
Feature key `suppliers.verification`. Turns the flat `supplier_relationships.status` into a
real onboarding/compliance flow.
- **Migration:** `supplier_verification_cases`(buyer_org_id, supplier_org_id UNIQUE together,
  status[NEW,IN_REVIEW,APPROVED,REJECTED], review_notes, reviewed_by, reviewed_at) +
  `supplier_verification_documents`(case_id, buyer_org_id, supplier_org_id,
  doc_type[VOEN,LICENSE,BANK,INSURANCE], storage_key, filename, sha256, status[PENDING,
  ACCEPTED,REJECTED]). Cross-org: **supplier** uploads docs, **buyer** decides — buyer status
  writes via a `SECURITY DEFINER verification_decide()` seam (supplier can't be the writer).
- **Flow:** buyer invites → case NEW → supplier uploads required docs (reuse the §1a upload) →
  buyer reviews each doc + decides the case → on APPROVED, set `supplier_relationships` =
  APPROVED (this is the gate the direct-order / catalog features already require). Notify both.
- **UI:** supplier "Profile & verification" (upload, see status, VÖEN); buyer verification
  panel on the supplier registry (review docs, approve/reject).
- **Test:** supplier uploads → buyer approves → relationship APPROVED; supplier can't self-
  approve; foreign buyer can't see the case.

---

## GROUP 4 — P2P: invoices + 3-way match + payment  ·  effort L
Feature key `p2p.invoicing`. Closes the financial loop (Peppol e-invoicing is a later phase).
- **Migration:** `invoices`(buyer_org_id, supplier_org_id, po_id, invoice_no, currency,
  net_minor, vat_minor, gross_minor, status[SUBMITTED,MATCHED,DISPUTED,APPROVED,PAID,REJECTED],
  issued_at, due_date, match jsonb) + `invoice_items`(invoice_id, po_item_id, qty,
  unit_price_minor, line_total_minor). Cross-org: **supplier** submits, **buyer** approves/pays
  via a `SECURITY DEFINER invoice_set_status()` seam.
- **3-way match:** on submit, compare invoice ↔ PO (ordered) ↔ GRN (received, from §1c);
  per-line qty and price variance within tolerance → MATCHED, else DISPUTED, with the diff in
  `match`. All money in minor units, server-computed.
- **API:** supplier `POST /invoices {poId, items,...}`; buyer `GET /invoices`,
  `POST /invoices/:id/approve`, `POST /invoices/:id/pay` (manual PAID for MVP), `/reject`.
- **UI:** supplier "Invoices" (submit from a PO); buyer "Invoices" (match result, approve, pay).
- **Test:** matched invoice happy path; price-variance → DISPUTED; supplier can't approve own
  invoice; foreign org blocked.

---

## Suggested order & rough effort
1. **Group 1 remainder** — attachments (S–M) → GRN (M) → multi-lot (M) → multi-step approval (L).
2. **Catalogs** (M–L).
3. **Verification** (L) — unlocks trustworthy direct-order/catalog gating.
4. **P2P invoices** (L) — depends on GRN (§1c) for the 3-way match.

Each block: migration (grants + `release_versions` row) → service/controller → UI + i18n →
e2e (happy + hostile isolation) → keep the full suite green → commit → push.

---

## Beyond the original roadmap (done)
- **Budgets & commitment control** (mig 0018, feature `controls.budgets`): buyer defines a
  spend ceiling per category + calendar year; APPROVED requests commit against the matching
  budget (encumbrance model). Utilization is derived; approval attaches a soft, non-blocking
  `budgetWarnings` when a budget is exceeded. UI `/buyer/budgets` with utilization bars.
- **Spend analytics** (`/buyer/analytics`): 12-month spend chart (ACCEPTED POs), spend by
  category, top-5 suppliers, tender savings (estimate vs awarded, per event), invoices
  paid/outstanding — all RLS-scoped, no chart library.
- **PO amendments / change orders** (mig 0019): buyer proposes per-line qty/price changes
  on an ISSUED/CONFIRMED order; supplier accepts (lines + total update atomically via the
  SECURITY DEFINER seam) or rejects; old→new snapshot kept as history. Both UIs wired.
- **RFI/RFP event types**: RFP = sealed prices + technical proposal (revealed only at the
  opening ceremony, then normal weighted evaluation + award); RFI = information gathering —
  text response only, sealed until opening for equal treatment, no evaluation/award. Buyer
  picks RFQ/RFP/RFI when creating the event; supplier bid form adapts per type.
