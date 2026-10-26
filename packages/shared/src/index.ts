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
  'BUYER_USER',
  'SUPPLIER_USER',
] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const BUYER_ROLES: MembershipRole[] = ['BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER'];

// ---------------- Suppliers ----------------
export const SUPPLIER_RELATIONSHIP_STATUSES = ['INVITED', 'APPROVED', 'BLOCKED'] as const;
export type SupplierRelationshipStatus = (typeof SUPPLIER_RELATIONSHIP_STATUSES)[number];

// ---------------- Procurement requests ----------------
export const REQUEST_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const;
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
