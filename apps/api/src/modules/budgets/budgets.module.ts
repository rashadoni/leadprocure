import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get,
  Injectable, Module, NotFoundException, Param, Post, Put, Query, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min, MinLength,
} from 'class-validator';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { CurrentUser, RequiresFeature, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';
import { NotifyModule, NotifyService } from '../../common/notify/notify.module';

export const BUDGET_PERIOD_TYPES = ['YEAR', 'QUARTER', 'MONTH'] as const;
export type BudgetPeriodType = (typeof BUDGET_PERIOD_TYPES)[number];

class UpsertBudgetDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() category?: string; // omit / '*' = all categories
  @IsOptional() @IsUUID() departmentId?: string; // omit = every department (org-wide ceiling)
  @IsInt() @Min(2000) periodYear!: number;
  // How the year is sliced. QUARTER needs periodQuarter (1–4), MONTH needs periodMonth (1–12).
  @IsOptional() @IsIn(BUDGET_PERIOD_TYPES) periodType?: BudgetPeriodType;
  @IsOptional() @IsInt() @Min(1) @Max(4) periodQuarter?: number;
  @IsOptional() @IsInt() @Min(1) @Max(12) periodMonth?: number;
  // Escape hatch for a non-calendar period: an explicit first day; the length still
  // comes from periodType.
  @IsOptional() @IsDateString() periodStart?: string;
  @IsInt() @Min(0) amountMinor!: number;
  // AZN only. Kept accepted-but-constrained rather than removed, so an older client that
  // still sends "AZN" keeps working while anything else fails loudly instead of creating a
  // budget that could never match a thing.
  @IsOptional() @IsIn(['AZN'], { message: 'currency: budgets are kept in AZN only' }) currency?: 'AZN';
  // Why the amount is what it is — kept in the revision ledger, not just the audit log.
  @IsOptional() @IsString() reason?: string;
}

class RolloverDto {
  @IsUUID() sourceBudgetId!: string;
}

class BudgetPolicyDto {
  @IsOptional() @IsInt() @Min(1) @Max(1000) warnPct?: number;
  // null clears the block (the default state) — pass a number to arm it.
  @IsOptional() @IsInt() @Min(1) @Max(1000) blockPct?: number | null;
  @IsOptional() @IsBoolean() allowOverride?: boolean;
}

export interface BudgetPolicy {
  warnPct: number;
  blockPct: number | null;
  allowOverride: boolean;
}

export interface BudgetImpact {
  budgetId: string;
  budgetName: string;
  departmentCode: string | null;
  periodLabel: string;
  currency: string;
  amountMinor: number;
  currentUsedMinor: number;
  requestMinor: number;
  projectedUsedMinor: number;
  projectedPct: number;
  warnPct: number;
  blockPct: number | null;
  wouldWarn: boolean;
  wouldBlock: boolean;
}

export interface BudgetPeriod {
  type: BudgetPeriodType;
  start: string; // YYYY-MM-DD, inclusive
  end: string;   // YYYY-MM-DD, inclusive
  year: number;
}

// Budgets are kept in AZN only — see migration 0034. Requests are AZN by construction, so
// every commitment already is; foreign-currency ORDERS (a contract inherits its tender's
// evaluation currency) are reported separately instead of being converted at a guessed rate.
export const BUDGET_CURRENCY = 'AZN';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

// Share of a period already gone, clamped to 0–100: a period still ahead reads 0, a closed
// one reads 100, so a finished budget never looks "ahead of pace".
function elapsedShare(from: string, to: string, today: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`) + DAY_MS; // end date is inclusive
  const now = Date.parse(`${today}T00:00:00Z`) + DAY_MS;
  if (!(end > start)) return 100;
  const pct = ((now - start) / (end - start)) * 100;
  return Math.round(Math.min(100, Math.max(0, pct)) * 10) / 10;
}

// Sentinel scope for a BUYER_USER with no home department: matches no budget, so they see
// an empty list instead of the whole organization's plan.
const NO_DEPARTMENT = '00000000-0000-0000-0000-000000000000';

// One place that turns "2026 / Q3" (or an explicit first day) into an inclusive date
// range. Everything downstream — storage, utilization, filtering — speaks ranges only.
export function resolveBudgetPeriod(dto: {
  periodType?: BudgetPeriodType;
  periodYear: number;
  periodQuarter?: number;
  periodMonth?: number;
  periodStart?: string;
}): BudgetPeriod {
  const type = dto.periodType ?? (dto.periodMonth ? 'MONTH' : dto.periodQuarter ? 'QUARTER' : 'YEAR');
  if (type === 'QUARTER' && !dto.periodQuarter && !dto.periodStart) {
    throw new BadRequestException('periodQuarter (1–4) is required for a quarterly budget');
  }
  if (type === 'MONTH' && !dto.periodMonth && !dto.periodStart) {
    throw new BadRequestException('periodMonth (1–12) is required for a monthly budget');
  }
  const start = dto.periodStart
    ? new Date(`${dto.periodStart.slice(0, 10)}T00:00:00Z`)
    : type === 'YEAR'
      ? new Date(Date.UTC(dto.periodYear, 0, 1))
      : type === 'QUARTER'
        ? new Date(Date.UTC(dto.periodYear, (dto.periodQuarter! - 1) * 3, 1))
        : new Date(Date.UTC(dto.periodYear, dto.periodMonth! - 1, 1));
  if (Number.isNaN(start.getTime())) throw new BadRequestException('Invalid periodStart');
  const months = type === 'YEAR' ? 12 : type === 'QUARTER' ? 3 : 1;
  // Day 0 of the month after the range = its last day, so month lengths and leap years
  // take care of themselves.
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 0));
  return { type, start: iso(start), end: iso(end), year: start.getUTCFullYear() };
}

// Short human label for the UI and for warning messages: "2026", "2026 Q3", "2026-07".
export function budgetPeriodLabel(type: string, start: string): string {
  const [y, m] = start.split('-');
  if (type === 'QUARTER') return `${y} Q${Math.floor((Number(m) - 1) / 3) + 1}`;
  if (type === 'MONTH') return `${y}-${m}`;
  return y;
}

export interface BudgetWarning {
  budgetId: string;
  name: string;
  category: string;
  departmentCode: string | null;
  periodYear: number;
  periodType: string;
  periodLabel: string;
  currency: string;
  amountMinor: number;
  committedMinor: number;
  overByMinor: number;
}

// Encumbrance budgets: APPROVED procurement requests commit against the matching budget
// (category + period + currency). Utilization is derived, never stored, so it always
// reflects current request state. All queries run under the buyer's RLS context.
@Injectable()
export class BudgetsService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
  ) {}

  // Every APPROVED request is charged to EXACTLY ONE budget — the most specific one that
  // covers it: department+category → department → category → org-wide. Letting each budget
  // sum its own matches (the old model) counted the same spend twice whenever an org-wide
  // and a department budget both applied, and inflated every rollup.
  //
  // Dated by APPROVAL, not creation: a request raised in December and approved in January
  // is January's commitment. `period_end + 1` keeps the last day of the range inclusive.
  // Live POs supersede the estimate they came from: once a request turns into an order,
  // the real order value is the number that counts, and the estimate must stop counting
  // too (otherwise the same spend lands in the budget twice). CANCELLED/REJECTED orders
  // are not live, so they release the actual and the estimate takes over again.
  private readonly MATCHED_CTE = `
    matched AS (
      SELECT pr.id, pr.request_no, pr.title, pr.category, pr.department_id, pr.currency,
             pr.estimated_total_minor, pr.approved_at, m.budget_id,
             COALESCE(po.actual_minor, 0)::bigint AS actual_minor,
             (po.actual_minor IS NOT NULL) AS has_order
      FROM procurement_requests pr
      LEFT JOIN LATERAL (
        SELECT b.id AS budget_id
        FROM budgets b
        WHERE b.currency = pr.currency
          AND pr.approved_at >= b.period_start::timestamptz
          AND pr.approved_at < (b.period_end + 1)::timestamptz
          AND (b.department_id IS NULL OR b.department_id = pr.department_id)
          AND (b.category = '*' OR b.category = pr.category)
        ORDER BY (b.department_id IS NOT NULL) DESC, (b.category <> '*') DESC,
                 b.period_start DESC, b.id
        LIMIT 1
      ) m ON true
      LEFT JOIN LATERAL (
        SELECT sum(o.total_minor)::bigint AS actual_minor
        FROM purchase_orders o
        WHERE o.request_id = pr.id AND o.status NOT IN ('CANCELLED','REJECTED')
          -- SAME currency only. A contract inherits its tender's evaluation currency, so an
          -- order can be foreign while the request is AZN; adding its minor units here would
          -- silently mix currencies at face value. A foreign order leaves the AZN estimate
          -- standing as the commitment and is reported separately (matched_orders below).
          AND o.currency = pr.currency
        HAVING count(*) > 0
      ) po ON true
      WHERE pr.status = 'APPROVED' AND pr.approved_at IS NOT NULL
    ),
    -- Every live order NOT already counted as its request's actual: catalog call-offs (no
    -- request at all) and foreign-currency orders. With no request there is no category
    -- either, so only a category-agnostic budget ('*') may claim one — an "IT" budget must
    -- not silently absorb spend nobody classified. Budgets are AZN-only, so a foreign order
    -- matches nothing and lands in the unbudgeted report with its currency shown, rather
    -- than disappearing. Dated by issue, falling back to creation.
    matched_orders AS (
      SELECT o.id, o.po_no, o.total_minor, o.currency, o.department_id,
             COALESCE(o.issued_at, o.created_at) AS spent_at, mb.budget_id
      FROM purchase_orders o
      LEFT JOIN procurement_requests r ON r.id = o.request_id
      LEFT JOIN LATERAL (
        SELECT b.id AS budget_id
        FROM budgets b
        WHERE b.currency = o.currency
          AND b.category = '*'
          AND COALESCE(o.issued_at, o.created_at) >= b.period_start::timestamptz
          AND COALESCE(o.issued_at, o.created_at) < (b.period_end + 1)::timestamptz
          AND (b.department_id IS NULL OR b.department_id = o.department_id)
        ORDER BY (b.department_id IS NOT NULL) DESC, b.period_start DESC, b.id
        LIMIT 1
      ) mb ON true
      WHERE o.status NOT IN ('CANCELLED','REJECTED')
        AND (o.request_id IS NULL OR o.currency <> r.currency)
    )`;

  // Plan / Commitment / Actual. Commitment and actual are mutually exclusive per request;
  // request-less orders are pure actual.
  private readonly COMMITTED_JOIN = `
    LEFT JOIN (
      SELECT budget_id, sum(committed)::bigint AS committed, sum(actual)::bigint AS actual
      FROM (
        SELECT budget_id,
               CASE WHEN has_order THEN 0 ELSE estimated_total_minor END AS committed,
               actual_minor AS actual
        FROM matched WHERE budget_id IS NOT NULL
        UNION ALL
        SELECT budget_id, 0, total_minor FROM matched_orders WHERE budget_id IS NOT NULL
      ) x GROUP BY budget_id
    ) c ON c.budget_id = b.id`;

  // Filters: a plain year (every budget whose range starts in it) or an explicit
  // from/to window, optionally narrowed to one period type or one department.
  // `scopeDepartmentId` is the viewer's own scope, not a user-supplied filter.
  async list(
    filter: {
      year?: number; periodType?: string; from?: string; to?: string;
      departmentId?: string; scopeDepartmentId?: string | null;
    } = {},
  ) {
    const rows = await this.rc.manager.query(
      `WITH ${this.MATCHED_CTE}
       SELECT b.id, b.name, b.category, b.department_id, b.period_type,
              b.period_start, b.period_end, b.amount_minor, b.currency, b.created_at,
              d.code AS department_code, d.name AS department_name,
              COALESCE(c.committed, 0) AS committed_minor,
              COALESCE(c.actual, 0) AS actual_minor
       FROM budgets b
       LEFT JOIN departments d ON d.id = b.department_id
       ${this.COMMITTED_JOIN}
       WHERE ($1::int IS NULL OR EXTRACT(YEAR FROM b.period_start)::int = $1)
         AND ($2::text IS NULL OR b.period_type = $2)
         AND ($3::date IS NULL OR b.period_end >= $3)
         AND ($4::date IS NULL OR b.period_start <= $4)
         AND ($5::uuid IS NULL OR b.department_id = $5)
         AND ($6::uuid IS NULL OR b.department_id = $6)
       ORDER BY b.period_start DESC, d.code NULLS FIRST, b.name`,
      [
        filter.year ?? null, filter.periodType ?? null, filter.from ?? null, filter.to ?? null,
        filter.departmentId ?? null, filter.scopeDepartmentId ?? null,
      ],
    );
    return rows.map((r: any) => this.shape(r));
  }

  // The other half of one-budget-per-request: approved spend that matched NO budget at
  // all. Without this the numbers look complete while real money sits outside every plan.
  async unbudgeted(filter: { from?: string; to?: string } = {}) {
    const rows = await this.rc.manager.query(
      `WITH ${this.MATCHED_CTE}
       SELECT 'REQUEST' AS kind, m.id, m.request_no AS doc_no, m.title, m.category, m.currency,
              m.estimated_total_minor AS amount_minor, m.approved_at AS spent_at,
              d.code AS department_code
       FROM matched m
       LEFT JOIN departments d ON d.id = m.department_id
       WHERE m.budget_id IS NULL
         AND ($1::date IS NULL OR m.approved_at >= $1::timestamptz)
         AND ($2::date IS NULL OR m.approved_at < ($2::date + 1)::timestamptz)
       UNION ALL
       SELECT 'ORDER', o.id, o.po_no, NULL, NULL, o.currency, o.total_minor, o.spent_at,
              d.code
       FROM matched_orders o
       LEFT JOIN departments d ON d.id = o.department_id
       WHERE o.budget_id IS NULL
         AND ($1::date IS NULL OR o.spent_at >= $1::timestamptz)
         AND ($2::date IS NULL OR o.spent_at < ($2::date + 1)::timestamptz)
       ORDER BY spent_at DESC`,
      [filter.from ?? null, filter.to ?? null],
    );
    return rows.map((r: any) => ({
      kind: r.kind,
      // requestId is kept for the REQUEST rows so existing callers keep working
      requestId: r.kind === 'REQUEST' ? r.id : null,
      id: r.id, docNo: r.doc_no, requestNo: r.doc_no,
      title: r.title,
      category: r.category === '*' ? null : r.category,
      departmentCode: r.department_code ?? null,
      currency: r.currency, amountMinor: Number(r.amount_minor),
      approvedAt: r.spent_at,
    }));
  }

  // ---------- thresholds ----------

  async getPolicy(): Promise<BudgetPolicy> {
    const row = (
      await this.rc.manager.query(`SELECT warn_pct, block_pct, allow_override FROM budget_policies LIMIT 1`)
    )[0];
    // Defaults, not an error: an org that never configured thresholds still warns at 80%
    // and blocks nothing.
    return {
      warnPct: row ? Number(row.warn_pct) : 80,
      blockPct: row?.block_pct == null ? null : Number(row.block_pct),
      allowOverride: row ? row.allow_override : true,
    };
  }

  async setPolicy(dto: BudgetPolicyDto, auth: AccessTokenPayload): Promise<BudgetPolicy> {
    if (dto.blockPct != null && dto.warnPct != null && dto.blockPct < dto.warnPct) {
      throw new BadRequestException('blockPct must be at least warnPct — blocking before warning makes no sense');
    }
    await this.rc.manager.query(
      `INSERT INTO budget_policies(buyer_org_id, warn_pct, block_pct, allow_override)
       VALUES ($1, COALESCE($2, 80), $3, COALESCE($4, true))
       ON CONFLICT (buyer_org_id) DO UPDATE
         SET warn_pct = COALESCE($2, budget_policies.warn_pct),
             block_pct = $3,
             allow_override = COALESCE($4, budget_policies.allow_override),
             updated_at = now()`,
      [auth.org_id, dto.warnPct ?? null, dto.blockPct ?? null, dto.allowOverride ?? null],
    );
    await this.audit.record('BUDGET_POLICY_UPDATED', 'budget_policy', auth.org_id, {
      warnPct: dto.warnPct ?? null, blockPct: dto.blockPct ?? null, allowOverride: dto.allowOverride ?? null,
    });
    return this.getPolicy();
  }

  // What approving this request WOULD do to its budget. Answers the question the old
  // control could not: "this request eats 92% of IT / Q3" — before anyone clicks approve.
  // Matching mirrors the committed engine, but dates the request at now(), since a
  // not-yet-approved request has no approved_at.
  async impactFor(requestId: string): Promise<BudgetImpact | null> {
    const m = this.rc.manager;
    const req = (
      await m.query(
        `SELECT id, category, department_id, currency, estimated_total_minor, status FROM procurement_requests WHERE id = $1`,
        [requestId],
      )
    )[0];
    if (!req) throw new NotFoundException('Request not found');

    const budget = (
      await m.query(
        `SELECT b.id FROM budgets b
         WHERE b.currency = $1
           AND now() >= b.period_start::timestamptz
           AND now() < (b.period_end + 1)::timestamptz
           AND (b.department_id IS NULL OR b.department_id = $2)
           AND (b.category = '*' OR b.category = $3)
         ORDER BY (b.department_id IS NOT NULL) DESC, (b.category <> '*') DESC, b.period_start DESC, b.id
         LIMIT 1`,
        [req.currency, req.department_id, req.category],
      )
    )[0];
    if (!budget) return null; // no budget covers this spend — the unbudgeted report's job

    const current = (await this.list()).find((b: any) => b.id === budget.id);
    if (!current) return null;
    const policy = await this.getPolicy();
    const amount = Number(req.estimated_total_minor);
    // An already-APPROVED request is inside usedMinor; don't count it twice.
    const projected = current.usedMinor + (req.status === 'APPROVED' ? 0 : amount);
    const pct = current.amountMinor > 0 ? Math.round((projected / current.amountMinor) * 1000) / 10 : 0;
    return {
      budgetId: current.id, budgetName: current.name,
      departmentCode: current.departmentCode, periodLabel: current.periodLabel,
      currency: current.currency, amountMinor: current.amountMinor,
      currentUsedMinor: current.usedMinor, requestMinor: amount,
      projectedUsedMinor: projected, projectedPct: pct,
      warnPct: policy.warnPct, blockPct: policy.blockPct,
      wouldWarn: pct >= policy.warnPct,
      wouldBlock: policy.blockPct != null && pct > policy.blockPct,
    };
  }

  // Called from approve() INSIDE its transaction: throwing here rolls the approval back,
  // which is exactly what a hard block must do. Returns the warnings to attach otherwise.
  async enforceOnApproval(
    requestId: string,
    auth: AccessTokenPayload,
    overrideReason?: string,
  ): Promise<BudgetWarning[]> {
    const policy = await this.getPolicy();
    const impact = await this.impactFor(requestId);
    if (impact && impact.wouldBlock) {
      if (!overrideReason) {
        throw new ForbiddenException(
          `Budget "${impact.budgetName}"${impact.departmentCode ? ` (${impact.departmentCode})` : ''} ` +
          `would reach ${impact.projectedPct}% of ${impact.periodLabel}, over the ${impact.blockPct}% block threshold. ` +
          (policy.allowOverride ? 'An admin may approve with a written override reason.' : 'Overrides are disabled for this organization.'),
        );
      }
      if (!policy.allowOverride) {
        throw new ForbiddenException('Budget overrides are disabled for this organization');
      }
      if (auth.role !== 'BUYER_ADMIN') {
        throw new ForbiddenException('Only a BUYER_ADMIN may override a budget block');
      }
      await this.audit.record('BUDGET_BLOCK_OVERRIDDEN', 'budget', impact.budgetId, {
        request_id: requestId, projected_pct: impact.projectedPct, block_pct: impact.blockPct,
        reason: overrideReason,
      });
    }
    // Crossing the warn line is worth telling the budget owner about, whether or not the
    // budget is actually over.
    if (impact && impact.wouldWarn) {
      // Addressed to whoever answers for that department's budget; only if nobody is named
      // does this fall back to mailing the whole org. A budget alarm sent to 40 people is
      // one nobody acts on.
      const owner = (
        await this.rc.manager.query(
          `SELECT d.owner_user_id FROM budgets b JOIN departments d ON d.id = b.department_id WHERE b.id = $1`,
          [impact.budgetId],
        )
      )[0]?.owner_user_id ?? null;
      await this.notify.notifyUser(auth.org_id, owner, 'BUDGET_THRESHOLD_CROSSED', {
        title: `${impact.budgetName}${impact.departmentCode ? ` · ${impact.departmentCode}` : ''} (${impact.periodLabel})`,
        budget: impact.budgetName,
        utilization: `${impact.projectedPct}%`,
        status: impact.wouldBlock ? 'OVER_BLOCK_THRESHOLD' : 'OVER_WARN_THRESHOLD',
      });
    }
    return this.warningsForRequest({ id: requestId, approved_at: new Date() });
  }

  // Per-department rollup: what finance opens the page for. Plan / commitment / actual come
  // from the budgets themselves; PAID is cash that actually left, taken from the invoice's
  // own department_id (denormalized at submission, so this survives a PO being re-scoped).
  //
  // Paid is reported BESIDE the others, never added into them: an invoice is settlement of
  // an order already counted as actual, so summing them would double the spend.
  async rollup(
    filter: {
      year?: number; periodType?: string; from?: string; to?: string;
      scopeDepartmentId?: string | null;
    } = {},
  ) {
    const budgets = await this.list(filter);
    const byDep = new Map<string, any>();
    for (const b of budgets) {
      const key = b.departmentId ?? '';
      const cur = byDep.get(key) ?? {
        departmentId: b.departmentId, departmentCode: b.departmentCode,
        currency: b.currency, amountMinor: 0, committedMinor: 0, actualMinor: 0, paidMinor: 0,
        periodFrom: b.periodStart, periodTo: b.periodEnd,
      };
      cur.amountMinor += b.amountMinor;
      cur.committedMinor += b.committedMinor;
      cur.actualMinor += b.actualMinor;
      // widest window the department's budgets cover — the span PAID is measured over
      if (b.periodStart < cur.periodFrom) cur.periodFrom = b.periodStart;
      if (b.periodEnd > cur.periodTo) cur.periodTo = b.periodEnd;
      byDep.set(key, cur);
    }
    if (!byDep.size) return [];

    const paid = await this.rc.manager.query(
      `SELECT i.department_id, i.currency, sum(i.gross_minor)::bigint AS paid
       FROM invoices i
       WHERE i.status = 'PAID'
       GROUP BY i.department_id, i.currency`,
    );
    for (const row of paid) {
      const cur = byDep.get(row.department_id ?? '');
      // only AZN settles against an AZN budget; foreign invoices are reported elsewhere
      if (cur && row.currency === cur.currency) cur.paidMinor += Number(row.paid);
    }

    const today = iso(new Date());
    return [...byDep.values()]
      .map((d) => {
        const used = d.committedMinor + d.actualMinor;
        const utilizationPct = d.amountMinor > 0 ? Math.round((used / d.amountMinor) * 1000) / 10 : 0;
        // Pace: how much of the period has gone versus how much of the plan. "80% spent in
        // month five" is the thing finance wants to catch, and a bare utilization figure
        // never says it — 80% is fine in November and alarming in May.
        const elapsedPct = elapsedShare(d.periodFrom, d.periodTo, today);
        return {
          ...d,
          usedMinor: used,
          remainingMinor: d.amountMinor - used,
          utilizationPct,
          elapsedPct,
          // positive = burning faster than the calendar
          paceDeltaPct: Math.round((utilizationPct - elapsedPct) * 10) / 10,
        };
      })
      .sort((a, b) => (a.departmentCode ?? '').localeCompare(b.departmentCode ?? ''));
  }

  // A plain BUYER_USER sees only their own cost centre; approvers and admins see all.
  async scopeFor(auth: AccessTokenPayload): Promise<string | null> {
    if (auth.role !== 'BUYER_USER') return null;
    const row = await this.rc.manager.query(
      `SELECT department_id FROM memberships WHERE user_id = $1 AND org_id = $2 LIMIT 1`,
      [auth.sub, auth.org_id],
    );
    // No home department → no department budgets to show (rather than the whole org's).
    return row[0]?.department_id ?? NO_DEPARTMENT;
  }

  private shape(r: any) {
    const amount = Number(r.amount_minor);
    const committed = Number(r.committed_minor);
    const actual = Number(r.actual_minor ?? 0);
    // Utilization is what the budget is actually carrying: orders placed plus estimates
    // not yet ordered.
    const used = committed + actual;
    const start = iso(new Date(r.period_start));
    const end = iso(new Date(r.period_end));
    return {
      // derived from the range, not stored — one source of truth for the period
      id: r.id, name: r.name, category: r.category, periodYear: Number(start.slice(0, 4)),
      departmentId: r.department_id ?? null,
      departmentCode: r.department_code ?? null,
      departmentName: r.department_name ?? null,
      periodType: r.period_type, periodStart: start, periodEnd: end,
      periodLabel: budgetPeriodLabel(r.period_type, start),
      currency: r.currency, amountMinor: amount,
      committedMinor: committed, actualMinor: actual, usedMinor: used,
      remainingMinor: amount - used,
      utilizationPct: amount > 0 ? Math.round((used / amount) * 1000) / 10 : 0,
      createdAt: r.created_at,
    };
  }

  // A budget on category "it" never matches requests filed under "IT", and the mismatch is
  // silent — the budget just sits at 0%. Once the buyer curates a category list, hold
  // budgets to it. Orgs with an empty directory keep the old free-text behaviour.
  private async assertKnownCategory(category: string): Promise<void> {
    if (category === '*') return;
    const known = await this.rc.manager.query(`SELECT code FROM procurement_categories`);
    if (!known.length) return;
    if (!known.some((c: { code: string }) => c.code === category)) {
      throw new BadRequestException(
        `Unknown category "${category}". Use one of: ${known.map((c: any) => c.code).join(', ')} (or leave it empty for all categories)`,
      );
    }
  }

  async create(dto: UpsertBudgetDto, auth: AccessTokenPayload) {
    const period = resolveBudgetPeriod(dto);
    await this.assertKnownCategory(dto.category?.trim() || '*');
    let row: { id: string };
    try {
      row = (
        await this.rc.manager.query(
          `INSERT INTO budgets(buyer_org_id, name, category, department_id, period_type,
             period_start, period_end, amount_minor, currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            auth.org_id, dto.name, dto.category?.trim() || '*', dto.departmentId ?? null,
            period.type, period.start, period.end, dto.amountMinor, BUDGET_CURRENCY,
          ],
        )
      )[0];
    } catch (e: any) {
      throw this.friendlyConflict(e, dto, period);
    }
    await this.rc.manager.query(
      `INSERT INTO budget_revisions(buyer_org_id, budget_id, amount_before_minor, amount_after_minor, reason, created_by)
       VALUES ($1,$2,NULL,$3,$4,$5)`,
      [auth.org_id, row.id, dto.amountMinor, dto.reason?.trim() || 'Initial plan', auth.sub],
    );
    await this.audit.record('BUDGET_CREATED', 'budget', row.id, {
      name: dto.name, periodType: period.type, periodStart: period.start,
    });
    return this.getOne(row.id);
  }

  async update(id: string, dto: UpsertBudgetDto, auth: AccessTokenPayload) {
    const period = resolveBudgetPeriod(dto);
    await this.assertKnownCategory(dto.category?.trim() || '*');
    // The amount is money, not a field: changing it writes a revision so "the plan was
    // 500k until March" stays answerable.
    const before = (await this.rc.manager.query(`SELECT amount_minor FROM budgets WHERE id=$1`, [id]))[0];
    if (!before) throw new NotFoundException('Budget not found');
    let res: Array<{ id: string }>;
    try {
      res = await this.rc.manager.query(
        `UPDATE budgets SET name=$2, category=$3, department_id=$4, period_type=$5,
           period_start=$6, period_end=$7, amount_minor=$8, currency=$9, updated_at=now()
         WHERE id=$1 RETURNING id`,
        [
          id, dto.name, dto.category?.trim() || '*', dto.departmentId ?? null,
          period.type, period.start, period.end, dto.amountMinor, BUDGET_CURRENCY,
        ],
      );
    } catch (e: any) {
      throw this.friendlyConflict(e, dto, period);
    }
    if (!res[0]) throw new NotFoundException('Budget not found');
    if (Number(before.amount_minor) !== dto.amountMinor) {
      await this.rc.manager.query(
        `INSERT INTO budget_revisions(buyer_org_id, budget_id, amount_before_minor, amount_after_minor, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [auth.org_id, id, Number(before.amount_minor), dto.amountMinor, dto.reason?.trim() || null, auth.sub],
      );
    }
    await this.audit.record('BUDGET_UPDATED', 'budget', id, {
      name: dto.name,
      amount_before: Number(before.amount_minor),
      amount_after: dto.amountMinor,
      reason: dto.reason?.trim() || null,
    });
    return this.getOne(id);
  }

  async revisions(budgetId: string) {
    const rows = await this.rc.manager.query(
      `SELECT r.id, r.amount_before_minor, r.amount_after_minor, r.reason, r.created_at,
              r.rollover_from_budget_id,
              (SELECT u.full_name FROM organization_users u WHERE u.id = r.created_by) AS created_by_name,
              (SELECT b2.name FROM budgets b2 WHERE b2.id = r.rollover_from_budget_id) AS rollover_from_name
       FROM budget_revisions r
       WHERE r.budget_id = $1
       ORDER BY r.created_at, r.id`,
      [budgetId],
    );
    return rows.map((r: any) => ({
      id: r.id,
      amountBeforeMinor: r.amount_before_minor == null ? null : Number(r.amount_before_minor),
      amountAfterMinor: Number(r.amount_after_minor),
      deltaMinor: r.amount_before_minor == null ? null : Number(r.amount_after_minor) - Number(r.amount_before_minor),
      reason: r.reason, createdAt: r.created_at, createdByName: r.created_by_name,
      rolloverFromBudgetId: r.rollover_from_budget_id, rolloverFromName: r.rollover_from_name,
    }));
  }

  // Carry an unspent remainder forward. Modelled as a revision of the TARGET budget with a
  // pointer back to the source, so the money's provenance stays visible instead of the
  // target's plan quietly growing.
  async rollover(sourceId: string, targetId: string, auth: AccessTokenPayload) {
    if (sourceId === targetId) throw new BadRequestException('Source and target must be different budgets');
    const all = await this.list();
    const source = all.find((b: any) => b.id === sourceId);
    const target = all.find((b: any) => b.id === targetId);
    if (!source || !target) throw new NotFoundException('Budget not found');
    if (source.currency !== target.currency) {
      throw new BadRequestException('Rollover between different currencies is not supported');
    }
    if (source.remainingMinor <= 0) {
      throw new BadRequestException(`"${source.name}" has nothing left to carry forward`);
    }
    const already = await this.rc.manager.query(
      `SELECT 1 FROM budget_revisions WHERE budget_id=$1 AND rollover_from_budget_id=$2 LIMIT 1`,
      [targetId, sourceId],
    );
    if (already.length) throw new ConflictException('This remainder has already been carried forward');

    const amount = target.amountMinor + source.remainingMinor;
    await this.rc.manager.query(`UPDATE budgets SET amount_minor=$2, updated_at=now() WHERE id=$1`, [targetId, amount]);
    await this.rc.manager.query(
      `INSERT INTO budget_revisions(buyer_org_id, budget_id, amount_before_minor, amount_after_minor, reason,
         rollover_from_budget_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        auth.org_id, targetId, target.amountMinor, amount,
        `Rollover from "${source.name}" (${source.periodLabel})`, sourceId, auth.sub,
      ],
    );
    await this.audit.record('BUDGET_ROLLED_OVER', 'budget', targetId, {
      from: sourceId, amount_minor: source.remainingMinor,
    });
    return this.getOne(targetId);
  }

  async remove(id: string) {
    const res = await this.rc.manager.query(`DELETE FROM budgets WHERE id=$1 RETURNING id`, [id]);
    if (!res[0]) throw new NotFoundException('Budget not found');
    await this.audit.record('BUDGET_DELETED', 'budget', id, {});
    return { ok: true };
  }

  // Two ways to collide: the same name in the same period (23505), or a second budget on
  // an already-covered (department, category, currency, period) scope (23P01, the EXCLUDE
  // constraint). Both are user errors that must read as 409, never as a 500.
  private friendlyConflict(e: any, dto: UpsertBudgetDto, period: BudgetPeriod): unknown {
    const label = budgetPeriodLabel(period.type, period.start);
    if (e?.code === '23505') {
      return new ConflictException(`A budget named "${dto.name}" already exists for ${label}`);
    }
    if (e?.code === '23P01') {
      const scope = dto.departmentId ? 'that department' : 'the whole organization';
      return new ConflictException(
        `Another budget already covers ${scope} / category "${dto.category?.trim() || '*'}" over ${label}. ` +
        'Overlapping budgets on the same scope would make utilization ambiguous — widen, narrow or merge them.',
      );
    }
    return e;
  }

  // Fetch one budget by id — not by listing them all and filtering in JS.
  private async getOne(id: string) {
    const rows = await this.rc.manager.query(
      `WITH ${this.MATCHED_CTE}
       SELECT b.id, b.name, b.category, b.department_id, b.period_type,
              b.period_start, b.period_end, b.amount_minor, b.currency, b.created_at,
              d.code AS department_code, d.name AS department_name,
              COALESCE(c.committed, 0) AS committed_minor,
              COALESCE(c.actual, 0) AS actual_minor
       FROM budgets b
       LEFT JOIN departments d ON d.id = b.department_id
       ${this.COMMITTED_JOIN}
       WHERE b.id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException('Budget not found');
    return this.shape(rows[0]);
  }

  // Everything the current filter shows, as CSV — the first thing finance asks for.
  async exportCsv(filter: Parameters<BudgetsService['list']>[0] = {}): Promise<string> {
    const rows = await this.list(filter);
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const money = (m: number) => (m / 100).toFixed(2);
    const header = [
      'Бюджет', 'Отдел', 'Категория', 'Период', 'С', 'По', 'План',
      'Обязательства', 'Факт', 'Использовано', 'Остаток', '%', 'Валюта',
    ];
    const lines = rows.map((b: any) => [
      b.name, b.departmentCode ?? '', b.category === '*' ? '' : b.category,
      b.periodLabel, b.periodStart, b.periodEnd,
      money(b.amountMinor), money(b.committedMinor), money(b.actualMinor),
      money(b.usedMinor), money(b.remainingMinor), b.utilizationPct, b.currency,
    ].map(esc).join(';'));
    return '﻿' + [header.map(esc).join(';'), ...lines].join('\r\n'); // BOM so Excel reads UTF-8
  }

  // Non-blocking: returns budgets that this (already-APPROVED) request has tipped over.
  // Called from request approval; never throws, so it can't break the approval flow.
  async warningsForRequest(req: { id: string; approved_at: string | Date | null }): Promise<BudgetWarning[]> {
    if (!req.approved_at) return [];
    // One request charges exactly one budget, so this returns at most one warning — but
    // the array shape is kept: callers (and the UI) already treat it as a list.
    const rows = await this.rc.manager.query(
      `WITH ${this.MATCHED_CTE}
       SELECT b.id, b.name, b.category, b.period_type, b.period_start,
              b.amount_minor, b.currency, d.code AS department_code,
              COALESCE(c.committed, 0) AS committed_minor,
              COALESCE(c.actual, 0) AS actual_minor
       FROM matched mine
       JOIN budgets b ON b.id = mine.budget_id
       LEFT JOIN departments d ON d.id = b.department_id
       ${this.COMMITTED_JOIN}
       WHERE mine.id = $1`,
      [req.id],
    );
    return rows
      .map((r: any) => ({ ...r, used: Number(r.committed_minor) + Number(r.actual_minor) }))
      .filter((r: any) => r.used > Number(r.amount_minor))
      .map((r: any) => ({
        budgetId: r.id, name: r.name, category: r.category,
        periodYear: Number(iso(new Date(r.period_start)).slice(0, 4)),
        departmentCode: r.department_code ?? null,
        periodType: r.period_type,
        periodLabel: budgetPeriodLabel(r.period_type, iso(new Date(r.period_start))),
        currency: r.currency, amountMinor: Number(r.amount_minor),
        committedMinor: r.used,
        overByMinor: r.used - Number(r.amount_minor),
      }));
  }
}

@Controller('budgets')
@RequiresFeature('controls.budgets')
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  async list(
    @CurrentUser() auth: AccessTokenPayload,
    @Query('year') year?: string,
    @Query('periodType') periodType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('departmentId') departmentId?: string,
  ) {
    return this.budgets.list({
      year: year ? Number(year) : undefined,
      periodType: periodType || undefined,
      from: from || undefined,
      to: to || undefined,
      departmentId: departmentId || undefined,
      scopeDepartmentId: await this.budgets.scopeFor(auth),
    });
  }

  // Approved spend that no budget covers — the blind spot a per-budget view can't show.
  @Get('unbudgeted')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  unbudgeted(@Query('from') from?: string, @Query('to') to?: string) {
    return this.budgets.unbudgeted({ from: from || undefined, to: to || undefined });
  }

  @Get('export')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  async exportCsv(
    @Res() res: Response,
    @Query('year') year?: string,
    @Query('periodType') periodType?: string,
    @Query('departmentId') departmentId?: string,
  ) {
    const csv = await this.budgets.exportCsv({
      year: year ? Number(year) : undefined,
      periodType: periodType || undefined,
      departmentId: departmentId || undefined,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="budgets.csv"');
    res.send(csv);
  }

  // Plan / commitment / actual / paid per department — the finance headline.
  @Get('rollup')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  async rollup(
    @CurrentUser() auth: AccessTokenPayload,
    @Query('year') year?: string,
    @Query('periodType') periodType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    // `current=1` is the common case: only the periods that contain today, which is what
    // pace is meaningful for.
    @Query('current') current?: string,
  ) {
    const today = new Date().toISOString().slice(0, 10);
    return this.budgets.rollup({
      year: year ? Number(year) : undefined,
      periodType: periodType || undefined,
      from: current ? today : from || undefined,
      to: current ? today : to || undefined,
      scopeDepartmentId: await this.budgets.scopeFor(auth),
    });
  }

  @Get('policy')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  policy() {
    return this.budgets.getPolicy();
  }

  @Put('policy')
  @Roles('BUYER_ADMIN')
  setPolicy(@Body() dto: BudgetPolicyDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.setPolicy(dto, auth);
  }

  // What approving this request would do to its budget — for the approve dialog.
  @Get('impact/:requestId')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  impact(@Param('requestId') requestId: string) {
    return this.budgets.impactFor(requestId);
  }

  @Post()
  @Roles('BUYER_ADMIN')
  create(@Body() dto: UpsertBudgetDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.create(dto, auth);
  }

  @Put(':id')
  @Roles('BUYER_ADMIN')
  update(@Param('id') id: string, @Body() dto: UpsertBudgetDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.update(id, dto, auth);
  }

  @Get(':id/revisions')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  revisions(@Param('id') id: string) {
    return this.budgets.revisions(id);
  }

  // Carry this budget's unspent remainder into another period's budget.
  @Post(':id/rollover')
  @Roles('BUYER_ADMIN')
  rollover(@Param('id') id: string, @Body() dto: RolloverDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.rollover(dto.sourceBudgetId, id, auth);
  }

  @Delete(':id')
  @Roles('BUYER_ADMIN')
  remove(@Param('id') id: string) {
    return this.budgets.remove(id);
  }
}

@Module({
  imports: [NotifyModule],
  controllers: [BudgetsController],
  providers: [BudgetsService],
  exports: [BudgetsService],
})
export class BudgetsModule {}
