// Shared domain vocabulary for Leadprocure — imported by both the API and the web app.
// Keep this framework-agnostic: enums, string-literal unions, plain types only.

// ---------------- Deployment & licensing ----------------
export const DEPLOYMENT_MODES = ['cloud_multi_tenant', 'on_prem_isolated', 'federated'] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export const IDENTITY_ORIGINS = ['SAAS', 'ON_PREM_LOCAL', 'FEDERATED'] as const;
export type IdentityOrigin = (typeof IDENTITY_ORIGINS)[number];

export const LICENSE_TYPES = ['client', 'server'] as const;
export type LicenseType = (typeof LICENSE_TYPES)[number];

export const EDITIONS = ['community', 'standard', 'enterprise'] as const;
export type Edition = (typeof EDITIONS)[number];

export const LICENSE_STATUSES = [
  'valid',
  'renewal_due',
  'grace',
  'expired_restricted',
  'revoked',
] as const;
export type LicenseStatus = (typeof LICENSE_STATUSES)[number];

// Feature keys are checked in code; editions are just bundles of these on the license server.
export const FEATURE_KEYS = [
  'sourcing.rfq',
  'sourcing.reverse_auction',
  'sourcing.multi_currency',
  'compliance.ocds_export',
  'signature.asan_imza',
  'ai.scoring',
  'suppliers.registry',
  'realtime.updates',
  'contracts.catalog',
  'suppliers.verification',
  'p2p.invoicing',
  'controls.budgets',
  'outreach.followups',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface LicenseLimits {
  max_buyer_orgs: number | null;
  seats: number | null;
  events_month: number | null;
}

export interface LicenseClaims {
  license_id: string;
  customer_id: string;
  deployment_type: DeploymentMode;
  license_type: LicenseType;
  edition: Edition;
  features: FeatureKey[];
  limits: LicenseLimits;
  valid_from: string; // ISO
  expires_at: string; // ISO
  grace_until: string; // ISO
  key_id: string;
  schema_version: number;
}

export interface EntitlementSnapshot {
  source?: 'installed' | 'file' | 'development' | 'missing';
  status: LicenseStatus;
  edition: Edition;
  deploymentMode: DeploymentMode;
  features: FeatureKey[];
  limits: LicenseLimits;
  expiresAt: string;
  graceUntil: string;
}

// ---------------- Identity & roles ----------------
export const ORGANIZATION_KINDS = ['BUYER', 'SUPPLIER', 'BOTH'] as const;
export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];

export const ORGANIZATION_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export const MEMBERSHIP_ROLES = [
  'BUYER_ADMIN',
  'BUYER_APPROVER',
  // Finance controller: owns the budget side (plans, thresholds, closing a period) and can
  // be named as a step in an approval chain, but runs none of procurement itself.
  'BUYER_FINANCE',
  'BUYER_USER',
  'SUPPLIER_USER',
] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const BUYER_ROLES: MembershipRole[] = ['BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_FINANCE', 'BUYER_USER'];

// Who may act on the budget side at all: the plan, its thresholds and closing a period.
export const BUDGET_ROLES: MembershipRole[] = ['BUYER_ADMIN', 'BUYER_FINANCE'];

// ---------------- Suppliers ----------------
export const SUPPLIER_RELATIONSHIP_STATUSES = ['INVITED', 'APPROVED', 'BLOCKED'] as const;
export type SupplierRelationshipStatus = (typeof SUPPLIER_RELATIONSHIP_STATUSES)[number];

// ---------------- Procurement requests ----------------
// CANCELLED is terminal for an APPROVED request that will never be ordered — it releases
// the budget commitment the approval was holding.
export const REQUEST_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const PROCUREMENT_METHODS = ['DIRECT', 'RFQ', 'OPEN_TENDER'] as const;
export type ProcurementMethod = (typeof PROCUREMENT_METHODS)[number];

export const VAT_MODES = ['INCLUSIVE', 'EXCLUSIVE'] as const;
export type VatMode = (typeof VAT_MODES)[number];

// ---------------- Sourcing events ----------------
export const SOURCING_EVENT_TYPES = ['RFI', 'RFP', 'RFQ', 'AUCTION'] as const;
export type SourcingEventType = (typeof SOURCING_EVENT_TYPES)[number];

export const SOURCING_EVENT_FORMATS = ['SEALED', 'OPEN', 'REVERSE', 'DUTCH'] as const;
export type SourcingEventFormat = (typeof SOURCING_EVENT_FORMATS)[number];

export const SOURCING_EVENT_STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'OPEN',
  'CLOSED',
  'OPENING',
  'EVALUATION',
  'AWARDED',
  'CANCELLED',
] as const;
export type SourcingEventStatus = (typeof SOURCING_EVENT_STATUSES)[number];

export const EVENT_VISIBILITIES = ['PUBLIC', 'INVITED'] as const;
export type EventVisibility = (typeof EVENT_VISIBILITIES)[number];

// Buyer may only read bid amounts once the event has reached (or passed) opening.
export const AMOUNTS_VISIBLE_FROM: SourcingEventStatus[] = ['OPENING', 'EVALUATION', 'AWARDED'];

// ---------------- Bids ----------------
export const BID_STATES = [
  'DRAFT',
  'SUBMITTED',
  'WITHDRAWN',
  'SUPERSEDED',
  'LATE',
  'OPENED',
  'DISQUALIFIED',
] as const;
export type BidState = (typeof BID_STATES)[number];

// ---------------- Contracts & purchase orders ----------------
export const CONTRACT_STATUSES = ['DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const PO_STATUSES = [
  'DRAFT', 'ISSUED', 'CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED', 'ACCEPTED', 'REJECTED', 'CANCELLED',
] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

// Which side may move a PO to which status (mirrors po_apply_status in the DB).
export const PO_SUPPLIER_TRANSITIONS: Record<string, PoStatus> = {
  ISSUED: 'CONFIRMED', CONFIRMED: 'PACKED', PACKED: 'SHIPPED', SHIPPED: 'DELIVERED',
};
export const PO_BUYER_NEXT: Record<string, PoStatus[]> = {
  DRAFT: ['ISSUED', 'CANCELLED'], ISSUED: ['CANCELLED'], DELIVERED: ['ACCEPTED', 'REJECTED'],
};

// ---------------- Budgets ----------------
// A budget is a document with a life of its own: drafted, submitted for approval, put in
// force, and finally closed when the period is signed off. Only APPROVED and CLOSED
// budgets hold money — a draft plan must never absorb real commitments.
export const BUDGET_STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'CLOSED'] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

// ---------------- Money ----------------
// Money is always integer minor units (e.g. qəpik for AZN) + ISO 4217 code. Never float.
export interface Money {
  amountMinor: number;
  currency: string;
}

export const DEFAULT_CURRENCY = 'AZN';
export const DEFAULT_VAT_RATE_BP = 1800; // 18% in basis points

// ---------------- Audit ----------------
export const AUDIT_ACTIONS = [
  'ORG_REGISTERED',
  'USER_LOGGED_IN',
  'REQUEST_SUBMITTED',
  'REQUEST_APPROVED',
  'REQUEST_REJECTED',
  'EVENT_PUBLISHED',
  'SUPPLIER_INVITED',
  'BID_SUBMITTED',
  'BID_WITHDRAWN',
  'EVENT_CLOSED',
  'EVENT_OPENED',
  'BID_DISQUALIFIED',
  'EVENT_EVALUATED',
  'EVENT_AWARDED',
  'LICENSE_INSTALLED',
  'SUPPLIER_APPROVED',
  'SUPPLIER_BLOCKED',
  'DOCUMENT_UPLOADED',
  'CONTRACT_CREATED',
  'CONTRACT_ACTIVATED',
  'PO_CREATED',
  'PO_STATUS_CHANGED',
  'AUCTION_BID_PLACED',
  'AUCTION_EXTENDED',
  'AUCTION_FINALIZED',
  'QNA_POSTED',
  'QNA_ANSWERED',
  'ADDENDUM_PUBLISHED',
  'ROLE_CHANGED',
  'SCORECARD_ENTRY_ADDED',
  'SHIPMENT_CREATED',
  'SHIPMENT_EVENT_ADDED',
  'GRN_RECORDED',
  'APPROVAL_STEP_ACTED',
  'CATALOG_CREATED',
  'CATALOG_ACTIVATED',
  'CATALOG_ORDER_CREATED',
  'VERIFICATION_OPENED',
  'VERIFICATION_DOC_UPLOADED',
  'VERIFICATION_DECIDED',
  'INVOICE_SUBMITTED',
  'INVOICE_STATUS_CHANGED',
  'CATEGORY_CREATED',
  'CATEGORY_DELETED',
  'BUDGET_CREATED',
  'BUDGET_UPDATED',
  'BUDGET_DELETED',
  'PO_AMENDMENT_PROPOSED',
  'PO_AMENDMENT_ACCEPTED',
  'PO_AMENDMENT_REJECTED',
  'EVENT_AWARD_CANCELLED',
  'FOLLOWUP_PLAN_UPDATED',
  'FOLLOWUP_ENROLLED',
  'FOLLOWUP_STOPPED',
  'FOLLOWUP_STEP_SENT',
  'FOLLOWUP_STEP_SCHEDULED',
  'FOLLOWUP_RECONCILED',
  'CHANNEL_SAVED',
  'CHANNEL_REMOVED',
  'CHANNEL_TEST_SENT',
  'DEPARTMENT_CREATED',
  'DEPARTMENT_UPDATED',
  'DEPARTMENT_DELETED',
  'MEMBER_DEPARTMENT_SET',
  'REQUEST_CANCELLED',
  'BUDGET_POLICY_UPDATED',
  'BUDGET_BLOCK_OVERRIDDEN',
  'BUDGET_ROLLED_OVER',
  'BUDGETS_IMPORTED',
  'BUDGET_SUBMITTED',
  'BUDGET_RECALLED',
  'BUDGET_APPROVED',
  'BUDGET_REJECTED',
  'BUDGET_CLOSED',
  'BUDGET_REOPENED',
  'BUDGET_PHASING_SET',
  'BUDGET_PHASING_CLEARED',
] as const;

// ---------------- Invoices (P2P) ----------------
export const INVOICE_STATUSES = ['SUBMITTED', 'MATCHED', 'DISPUTED', 'APPROVED', 'PAID', 'REJECTED'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

// ---------------- Supplier verification (KYC) ----------------
export const VERIFICATION_STATUSES = ['NEW', 'IN_REVIEW', 'APPROVED', 'REJECTED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export const VERIFICATION_DOC_TYPES = ['VOEN', 'LICENSE', 'BANK', 'INSURANCE', 'OTHER'] as const;
export type VerificationDocType = (typeof VERIFICATION_DOC_TYPES)[number];

// ---------------- Catalogs ----------------
export const CATALOG_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

// ---------------- Logistics ----------------
export const SHIPMENT_STATUSES = [
  'CREATED', 'PICKED_UP', 'IN_TRANSIT', 'CUSTOMS', 'ARRIVED', 'DELIVERED', 'EXCEPTION',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

// ---------------- Outreach follow-ups ----------------
export const FOLLOWUP_CHANNELS = ['EMAIL', 'WHATSAPP'] as const;
export type FollowupChannel = (typeof FOLLOWUP_CHANNELS)[number];
export const FOLLOWUP_STATUSES = ['ACTIVE', 'RESPONDED', 'STOPPED', 'EXHAUSTED', 'EVENT_CLOSED'] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];
export interface FollowupStep {
  channel: FollowupChannel;
  afterHours: number; // delay from the previous step (or from enrollment for step 0)
}
// Default chain when the buyer org has no plan of its own: two email nudges, then WhatsApp.
export const DEFAULT_FOLLOWUP_STEPS: FollowupStep[] = [
  { channel: 'EMAIL', afterHours: 24 },
  { channel: 'EMAIL', afterHours: 48 },
  { channel: 'WHATSAPP', afterHours: 48 },
];

// ---------------- Sending channels (per buyer org) ----------------
export const CHANNEL_TYPES = ['EMAIL', 'WHATSAPP'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// ---------------- Auth payloads ----------------
export interface AccessTokenPayload {
  sub: string; // user id
  org_id: string;
  org_kind: OrganizationKind;
  role: MembershipRole;
  token_version: number;
}

// ---------------- Settlement reporting: the two meanings of "paid" ----------------
// Two screens report settled invoices, and they deliberately report DIFFERENT numbers.
// This is the one place that says what each one means; both endpoints tag their payload
// with the basis below and both pages label the figure from it, so the difference is
// stated rather than left to be rediscovered as a defect.
//
// 'invoice_ledger' — GET /dashboard/spend-analytics → invoices.{paidMinor,outstandingMinor}
//   Every invoice RECORDED in the selected window, split into what has since been settled
//   and what is still owed. It asks nothing about budgets and nothing about what became of
//   the order: money paid out on a call-off withdrawn afterwards is money paid out, and an
//   accounts-payable view that hid it would hide exactly the leak it exists to show. Dated
//   by the invoice's own created_at — the day the organisation recorded the liability. (No
//   bank settlement date is stored anywhere, so this is not, and must not be labelled, the
//   day the money moved.)
//
// 'budget_obligation' — GET /budgets/rollup → paidMinor
//   Settlement of obligations the budget engine still counts (MATCHED_CTE), dated by the
//   obligation itself: the request's approved_at, or a requestless order's issue/creation.
//   A paid invoice whose order was withdrawn and whose request is gone carries no
//   commitment, is absent from the unbudgeted report too, and must not stand against any
//   plan.
//   WHICH ROW it lands on follows two different rules, and the column must not be
//   described as though it followed only the stricter one. A department row is credited
//   when the obligation's day falls inside that department's OWN selected plan periods,
//   and that credit then propagates to each of its ancestors — so a parent with no plan of
//   its own still reports its units' settlement. Either way the plan beside the figure need
//   not be the one that carried it (pinned: the 2036 case in budget-paid-period.e2e-spec.ts,
//   where a department reads used 0 and paid 700). Only the org-wide row is credited
//   strictly, with what its own plans actually carried. See the loop over `paid` in
//   rollup().
//   VAT: this is the invoice's GROSS, while commitment and actual are each order's own
//   basis — the raw sum of its lines, which taxTotals() makes NET under the default
//   EXCLUSIVE vat_mode and GROSS under INCLUSIVE. So a fully settled EXCLUSIVE order at
//   18% reads "used 1000 / paid 1180", and the column must say «incl. VAT» or that reads
//   as a data error. Gross is deliberate and is kept: it is the money that actually left,
//   and it is the basis the invoice list and the analytics tiles already report, so
//   restating it net here would buy comparability with the column beside it at the price
//   of a THIRD number for the same invoice — the defect this whole section exists to
//   prevent. Making paid comparable to used instead is a real alternative; it is a money
//   computation (CASE WHEN o.vat_mode = 'INCLUSIVE' THEN i.gross_minor ELSE i.net_minor
//   END) and so a decision of its own, not something to slip in behind a label.
//
// So the same paid invoice can appear on one page and not the other, and can fall in
// different months on each. That is the design: one is a ledger of invoices, the other is
// settlement of commitments. Neither figure is comparable to the other, and neither is
// summed into actual spend.
export const PAID_BASES = ['invoice_ledger', 'budget_obligation'] as const;
export type PaidBasis = (typeof PAID_BASES)[number];
