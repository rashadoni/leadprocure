import { returnedRows, safeMoney } from '../../common/procurement/invariants';
import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get,
  Injectable, Module, NotFoundException, Param, Post, Put, Query, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import {
  IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min,
  MinLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { AccessTokenPayload, PaidBasis } from '@leadprocure/shared';
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

// Rejecting a plan and reopening a closed period both have to say why — those are the two
// moments a controller will be asked to explain later.
class ReasonDto {
  @IsString() @MinLength(3) reason!: string;
}

class ImportCsvDto {
  @IsString() @MinLength(5) csv!: string;
}

class PhasingMonthDto {
  // 'YYYY-MM' — the month this share belongs to
  @IsString() @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month: expected YYYY-MM' }) month!: string;
  // basis points, so 12.5% is expressible without floats
  @IsInt() @Min(0) @Max(10000) shareBp!: number;
}
class SetPhasingDto {
  // an empty list clears the phasing and returns the budget to an even split
  @IsArray() @ValidateNested({ each: true }) @Type(() => PhasingMonthDto) months!: PhasingMonthDto[];
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

// Which of the two settlement measures this module reports. The union it is checked
// against carries both definitions: see PAID_BASES in @leadprocure/shared.
const BUDGET_OBLIGATION: PaidBasis = 'budget_obligation';

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

// Every month a period touches, as first-of-month ISO dates. A budget is phased month by
// month regardless of whether its period is a year, a quarter or a single month.
export function monthsOfPeriod(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T00:00:00Z`);
  const cur = new Date(`${from}T00:00:00Z`);
  cur.setUTCDate(1);
  while (cur <= end) {
    out.push(iso(cur));
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

// How much of the PLAN should have been spent by `today`, in percent.
//
// Without phasing this is just the share of the calendar that has gone — right for flat
// spend, wrong for anything seasonal. With phasing, a finished month contributes its whole
// share and the running month contributes its share pro rata by days, so pace and forecast
// answer "are we ahead of the plan" instead of "are we ahead of the calendar".
export function plannedShare(
  from: string,
  to: string,
  today: string,
  phasing: Array<{ month_start: string; share_bp: number }>,
): number {
  if (!phasing.length) return elapsedShare(from, to, today);
  const now = Date.parse(`${today}T00:00:00Z`) + DAY_MS; // end of today
  let bp = 0;
  for (const row of phasing) {
    const monthStart = Date.parse(`${String(row.month_start).slice(0, 10)}T00:00:00Z`);
    const next = new Date(monthStart);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const monthEnd = next.getTime();
    if (now >= monthEnd) bp += row.share_bp;
    else if (now > monthStart) bp += (row.share_bp * (now - monthStart)) / (monthEnd - monthStart);
  }
  return Math.round(Math.min(10000, Math.max(0, bp)) / 100 * 10) / 10;
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
        WHERE b.status IN ('APPROVED','CLOSED')
          AND b.currency = pr.currency
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
        WHERE b.status IN ('APPROVED','CLOSED')
          AND b.currency = o.currency
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
       SELECT b.id, b.name, b.category, b.department_id, b.period_type, b.status,
              b.submitted_at, b.approved_at, b.closed_at,
              b.closed_committed_minor, b.closed_actual_minor,
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
    await this.lockPlans();
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
         WHERE b.currency = $1 AND b.status IN ('APPROVED','CLOSED')
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

    await this.assertBudgetAccess(budget.id);
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
      wouldWarn: BigInt(projected) * 100n >= BigInt(current.amountMinor) * BigInt(policy.warnPct),
      wouldBlock: policy.blockPct != null && BigInt(projected) * 100n > BigInt(current.amountMinor) * BigInt(policy.blockPct),
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
        throw new ForbiddenException({
          statusCode: 403, error: 'Forbidden', code: 'BUDGET_LIMIT_EXCEEDED',
          canOverride: policy.allowOverride && auth.role === 'BUYER_ADMIN',
          message: `Budget "${impact.budgetName}"${impact.departmentCode ? ` (${impact.departmentCode})` : ''} ` +
          (impact.amountMinor === 0 ? 'has a zero limit and positive projected spend. ' :
          `would exceed the ${impact.blockPct}% block threshold for ${impact.periodLabel} (${impact.projectedUsedMinor} minor units). `) +
          (policy.allowOverride ? 'An admin may approve with a written override reason.' : 'Overrides are disabled for this organization.'),
        });
      }
      if (!policy.allowOverride) {
        throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: 'BUDGET_OVERRIDE_FORBIDDEN', canOverride: false, message: 'Budget overrides are disabled for this organization' });
      }
      if (auth.role !== 'BUYER_ADMIN') {
        throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: 'BUDGET_OVERRIDE_FORBIDDEN', canOverride: false, message: 'Only a BUYER_ADMIN may override a budget block' });
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
  // from the budgets themselves; PAID is settlement charged to the plan that CARRIED the
  // obligation, taken from the invoice's own department_id (denormalized at submission, so
  // this survives a PO being re-scoped).
  //
  // Paid is reported BESIDE the others, never added into them: an invoice is settlement of
  // an order already counted as actual, so summing them would double the spend.
  //
  // This is NOT the same measure as the invoice figures on /buyer/analytics, and the two
  // are not meant to agree — PAID_BASES in @leadprocure/shared states both definitions.
  // Here: only obligations MATCHED_CTE still counts, dated by the obligation (a request's
  // approved_at, a requestless order's issue/creation). There: every invoice recorded in
  // the window, dated by the invoice. So a paid invoice whose order was withdrawn shows up
  // on analytics and not here, and an invoice recorded in a month other than its
  // obligation's falls in a different month on each page. Both are correct answers to
  // different questions; the rows below carry `paidBasis` so the page can say which.
  async rollup(
    filter: {
      year?: number; periodType?: string; from?: string; to?: string;
      scopeDepartmentId?: string | null;
    } = {},
  ) {
    // Only signed-off plans. A draft is a proposal, not a ceiling: counting its amount here
    // inflated the department's plan while it could never carry any spend (matching is
    // restricted to APPROVED/CLOSED), so a department looked more comfortable the more
    // unapproved drafts someone had lying around.
    const budgets = (await this.list(filter)).filter((b: any) => b.status === 'APPROVED' || b.status === 'CLOSED');
    // Phasing for exactly these budgets, in one round trip. A department's pace is the
    // amount-weighted pace of its budgets, so a phased plan and a flat one can sit side by
    // side under the same parent and still add up.
    const phasing = new Map<string, Array<{ month_start: string; share_bp: number }>>();
    if (budgets.length) {
      const rows = await this.rc.manager.query(
        // to_char, not the raw date: the driver hands back a Date object for a `date` column,
        // and String()-slicing that yields "Tue Aug 11" — which parses to NaN and silently
        // made every phased budget report a planned share of zero.
        `SELECT budget_id, to_char(month_start, 'YYYY-MM-DD') AS month_start, share_bp
         FROM budget_phasing WHERE budget_id = ANY($1::uuid[]) ORDER BY month_start`,
        [budgets.map((b: any) => b.id)],
      );
      for (const r of rows) {
        const list = phasing.get(r.budget_id) ?? [];
        list.push({ month_start: String(r.month_start).slice(0, 10), share_bp: Number(r.share_bp) });
        phasing.set(r.budget_id, list);
      }
    }
    const todayIso = iso(new Date());
    // Departments form a tree, and a parent that ignores its children is not a rollup. Fold
    // every child's figures into its parent as well as reporting the child itself, so a
    // division shows what the division spends — its own budgets plus its units'.
    const tree: Array<{ id: string; parent_id: string | null; code: string }> =
      await this.rc.manager.query(`SELECT id, parent_id, code FROM departments`);
    const parentOf = new Map(tree.map((d) => [d.id, d.parent_id]));
    const codeOf = new Map(tree.map((d) => [d.id, d.code]));
    // every ancestor of a department, nearest first; cycles are impossible (a department
    // cannot be its own parent) but the seen-set keeps a corrupted row from looping forever
    const ancestors = (id: string | null): string[] => {
      const out: string[] = [];
      const seen = new Set<string>();
      let cur = id ? parentOf.get(id) ?? null : null;
      while (cur && !seen.has(cur)) { seen.add(cur); out.push(cur); cur = parentOf.get(cur) ?? null; }
      return out;
    };

    const byDep = new Map<string, any>();
    // Keep the union of selected periods: January + March must not include February,
    // and overlapping annual/monthly plans must not count an invoice twice.
    const paidWindows = new Map<string, Array<{ from: string; to: string }>>();
    const add = (key: string, b: any, rolledUp: boolean) => {
      const cur = byDep.get(key) ?? {
        departmentId: key || null,
        departmentCode: key ? codeOf.get(key) ?? null : null,
        // depth drives the indent in the UI; a rolled-up parent is marked so the reader
        // knows its figures include the units beneath it
        depth: ancestors(key || null).length,
        includesChildren: false,
        currency: b.currency, amountMinor: 0, committedMinor: 0, actualMinor: 0, paidMinor: 0,
        // plan that should have been spent by today, summed across this department's budgets
        plannedMinor: 0, phased: false,
        periodFrom: b.periodStart, periodTo: b.periodEnd,
      };
      const ph = phasing.get(b.id) ?? [];
      if (ph.length) cur.phased = true;
      cur.plannedMinor += (b.amountMinor * plannedShare(b.periodStart, b.periodEnd, todayIso, ph)) / 100;
      cur.amountMinor += b.amountMinor;
      cur.committedMinor += b.committedMinor;
      cur.actualMinor += b.actualMinor;
      if (rolledUp) cur.includesChildren = true;
      if (!rolledUp) {
        const windows = paidWindows.get(key) ?? [];
        windows.push({ from: b.periodStart, to: b.periodEnd });
        paidWindows.set(key, windows);
      }
      // Widest window for pace/forecast; settlement uses the selected period union.
      if (b.periodStart < cur.periodFrom) cur.periodFrom = b.periodStart;
      if (b.periodEnd > cur.periodTo) cur.periodTo = b.periodEnd;
      byDep.set(key, cur);
    };

    for (const b of budgets) {
      add(b.departmentId ?? '', b, false);
      for (const anc of ancestors(b.departmentId)) add(anc, b, true);
    }
    if (!byDep.size) return [];

    const paid = await this.rc.manager.query(
      // Use the same obligation date as budget utilization, not invoice creation or a
      // claimed bank payment date. Preserve the invoice's department snapshot and apply
      // the caller's scope before rolling children up to a shared parent.
      `WITH dated_paid AS (
         SELECT i.department_id, i.currency, i.gross_minor,
                CASE WHEN r.status = 'APPROVED' AND r.approved_at IS NOT NULL AND r.currency = o.currency
                     THEN r.approved_at ELSE COALESCE(o.issued_at, o.created_at) END AS budget_at,
                -- The same split as matched / matched_orders: a request dates and classifies
                -- its own spend, while a call-off nobody classified carries no category and
                -- only a category-agnostic plan ('*') may claim it.
                CASE WHEN r.status = 'APPROVED' AND r.approved_at IS NOT NULL AND r.currency = o.currency
                     THEN r.category ELSE NULL END AS category
         FROM invoices i
         JOIN purchase_orders o ON o.id = i.po_id
         LEFT JOIN procurement_requests r ON r.id = o.request_id
         -- Only obligations MATCHED_CTE still counts, by its own two tests. Its matched
         -- branch counts the REQUEST, whatever became of its orders — a cancelled order
         -- releases the actual and the estimate takes the commitment back (it says so
         -- above), so that settlement must keep standing beside it. Its matched_orders
         -- branch counts the ORDER, and only a live one that no same-currency request
         -- already speaks for. What neither counts carries no commitment, is absent from
         -- the unbudgeted report too, and its settlement must not stand against a plan:
         -- a withdrawn call-off, and an order whose request was cancelled (the app
         -- refuses to cancel a request that has a live order, but an order can still be
         -- drawn from a contract afterwards).
         WHERE i.status = 'PAID'
           AND ((r.status = 'APPROVED' AND r.approved_at IS NOT NULL)
                OR (o.status NOT IN ('CANCELLED','REJECTED')
                    AND (o.request_id IS NULL OR o.currency <> r.currency)))
           AND ($3::uuid IS NULL OR i.department_id = $3)
       ),
       -- Which plan carried this obligation, by MATCHED_CTE's own choice (same
       -- predicates, same ORDER BY) over EVERY plan of the org — not only the ones
       -- this report selected, because the commitment was charged without knowing
       -- about any filter. Only the org-wide row needs it; the department tree keeps
       -- its period-only rule, which is what the accepted matrix reports.
       settled AS (
         SELECT d.*, mb.budget_id
         -- Narrowed to the reported window BEFORE the lookup: one plan search per
         -- settlement in the period, not per settlement the org has ever made.
         FROM (SELECT * FROM dated_paid
               WHERE budget_at >= ($1::date::timestamp AT TIME ZONE 'UTC')
                 AND budget_at < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')) d
         LEFT JOIN LATERAL (
           SELECT b.id AS budget_id
           FROM budgets b
           WHERE b.status IN ('APPROVED','CLOSED')
             AND b.currency = d.currency
             AND d.budget_at >= b.period_start::timestamptz
             AND d.budget_at < (b.period_end + 1)::timestamptz
             AND (b.department_id IS NULL OR b.department_id = d.department_id)
             AND (b.category = '*' OR b.category = d.category)
           ORDER BY (b.department_id IS NOT NULL) DESC, (b.category <> '*') DESC,
                    b.period_start DESC, b.id
           LIMIT 1
         ) mb ON true
       )
       SELECT department_id, currency, budget_id,
              to_char(budget_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS budget_day,
              sum(gross_minor)::bigint AS paid
       FROM settled
       GROUP BY department_id, currency, budget_id, to_char(budget_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      [budgets.reduce((min: string, b: any) => b.periodStart < min ? b.periodStart : min, budgets[0].periodStart),
       budgets.reduce((max: string, b: any) => b.periodEnd > max ? b.periodEnd : max, budgets[0].periodEnd),
       filter.scopeDepartmentId ?? null],
    );
    const covers = (key: string, day: string) => !!paidWindows.get(key)?.some(
      (window) => day >= window.from && day <= window.to,
    );
    // The org-wide plans this report is showing. The '' row is their sum, so the
    // settlement that belongs on it is the settlement of the obligations they carried.
    const selectedOrgPlans = new Set<string>(
      budgets.filter((b: any) => !b.departmentId).map((b: any) => String(b.id)),
    );
    for (const row of paid) {
      // Departments: eligibility comes from the department's or an ancestor's OWN budgets,
      // never a sibling's period. Once covered, propagate once to each ancestor.
      let covered = false;
      for (const key of [row.department_id ?? '', ...ancestors(row.department_id ?? null)]) {
        if (!key) continue; // '' is the org-wide plan, not a department — see below
        const cur = byDep.get(key);
        // only AZN settles against an AZN budget; foreign invoices are reported elsewhere
        covered = covered || covers(key, row.budget_day);
        if (cur && row.currency === cur.currency && covered) cur.paidMinor += Number(row.paid);
      }
      // The org-wide row is nobody's ancestor, so a period that merely overlaps says
      // nothing: it is credited exactly when the plan that carried this obligation IS one
      // of its plans. Anything a department plan carried, or that no plan carried at all
      // (the unbudgeted report's job), leaves it alone. One settlement can still appear on
      // several rows of one report — a department, its ancestors, and this one — as the
      // plan figures do, and each row counts it at most once. Only this row's appearance
      // means "the plan here carried it"; a department's means "my period covers it",
      // which is the looser rule the accepted matrix reports (see the 2036 case).
      // Paid is also not comparable to used as a number: with the default EXCLUSIVE
      // vat_mode an order's total is net while an invoice's gross carries VAT, so 18%
      // spend settles at about 1.18× its actual (INCLUSIVE orders settle at about 1×).
      const org = byDep.get('');
      if (org && row.budget_id && selectedOrgPlans.has(String(row.budget_id))
          && row.currency === org.currency) {
        org.paidMinor += Number(row.paid);
      }
    }

    const today = iso(new Date());
    return [...byDep.values()]
      .map((d) => {
        const used = d.committedMinor + d.actualMinor;
        const utilizationPct = d.amountMinor > 0 ? Math.round((used / d.amountMinor) * 1000) / 10 : 0;
        // Pace: how much of the period has gone versus how much of the plan. "80% spent in
        // month five" is the thing finance wants to catch, and a bare utilization figure
        // never says it — 80% is fine in November and alarming in May.
        // Weighted across the department's budgets; with no phasing anywhere this is exactly
        // the share of the calendar that has gone, which is what it always was.
        const elapsedPct = d.amountMinor > 0
          ? Math.round((d.plannedMinor / d.amountMinor) * 1000) / 10
          : elapsedShare(d.periodFrom, d.periodTo, today);
        // Where this ends up if nothing changes. Pace answers "are we ahead?"; the forecast
        // answers the question that actually follows — "and what does that mean in money by
        // the end of the period?". Straight run-rate: spend so far, extrapolated over the
        // share of the period still to run. Meaningless before the period starts, so it
        // falls back to the plan rather than dividing by zero.
        const forecastMinor = elapsedPct > 0 ? Math.round((used / elapsedPct) * 100) : d.amountMinor;
        return {
          ...d,
          // Named on every row, so the page never has to guess which settlement measure
          // this is — nor a reader wonder why it disagrees with /buyer/analytics.
          paidBasis: BUDGET_OBLIGATION,
          usedMinor: used,
          remainingMinor: d.amountMinor - used,
          utilizationPct,
          elapsedPct,
          // the reader needs to know whether "should be at 58%" came from a plan or a calendar
          phased: d.phased,
          // positive = burning faster than the calendar
          paceDeltaPct: Math.round((utilizationPct - elapsedPct) * 10) / 10,
          forecastMinor,
          forecastPct: d.amountMinor > 0 ? Math.round((forecastMinor / d.amountMinor) * 1000) / 10 : 0,
          forecastOverMinor: Math.max(0, forecastMinor - d.amountMinor),
        };
      })
      .sort((a, b) => (a.depth - b.depth) || (a.departmentCode ?? '').localeCompare(b.departmentCode ?? ''));
  }

  // Who sees which budgets. Admin, finance and approvers see the whole plan — that is the
  // point of their jobs. A plain user sees their own cost centre, and nothing if they have
  // none: showing the organisation's entire plan to whoever happens to log in is the sort
  // of default nobody notices until it matters.
  //
  // A department OWNER is a plain user with one exception — their own department — which
  // falls out of the same rule, since the owner's home department is that department.
  async scopeFor(auth: AccessTokenPayload): Promise<string | null> {
    if (auth.role !== 'BUYER_USER') return null;
    const row = await this.rc.manager.query(
      `SELECT COALESCE(
                (SELECT d.id FROM departments d WHERE d.owner_user_id = $1 LIMIT 1),
                (SELECT m.department_id FROM memberships m WHERE m.user_id = $1 AND m.org_id = $2 LIMIT 1)
              ) AS department_id`,
      [auth.sub, auth.org_id],
    );
    return row[0]?.department_id ?? NO_DEPARTMENT;
  }

  // Writing a plan is narrower than reading one. Admin and finance may touch any budget; a
  // department owner may only touch their own department's, and only while it is theirs to
  // move (a draft they are preparing, or an amount revision on their own plan).
  private async assertMayWrite(auth: AccessTokenPayload, departmentId: string | null) {
    if (auth.role === 'BUYER_ADMIN' || auth.role === 'BUYER_FINANCE') return;
    const owned = departmentId
      ? await this.rc.manager.query(
          `SELECT 1 FROM departments WHERE id = $1 AND owner_user_id = $2`, [departmentId, auth.sub],
        )
      : [];
    if (!owned.length) {
      throw new ForbiddenException(
        'You may only draft budgets for a department you own — ask finance or an admin for anything wider',
      );
    }
  }

  private async lockPlans() {
    await this.rc.manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,85))`, [this.rc.orgId]);
  }

  private async assertBudgetAccess(id: string, write = false) {
    const b = (await this.rc.manager.query(`SELECT department_id FROM budgets WHERE id=$1`, [id]))[0];
    if (!b) throw new NotFoundException('Budget not found');
    const ctx = this.rc.get();
    if (ctx.role !== 'BUYER_USER') return;
    const auth = { sub: ctx.actorId, org_id: ctx.orgId, role: ctx.role } as AccessTokenPayload;
    if (write) await this.assertMayWrite(auth, b.department_id);
    else if (await this.scopeFor(auth) !== b.department_id) throw new ForbiddenException('Budget is outside your department');
  }

  private shape(r: any) {
    const amount = Number(r.amount_minor);
    // A signed-off period reports what it was signed off AS. Budgets closed before the
    // snapshot existed have none, and keep computing live rather than showing a zero.
    const frozen = r.status === 'CLOSED' && r.closed_committed_minor != null;
    const committed = frozen ? Number(r.closed_committed_minor) : Number(r.committed_minor);
    const actual = frozen ? Number(r.closed_actual_minor ?? 0) : Number(r.actual_minor ?? 0);
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
      status: r.status,
      submittedAt: r.submitted_at ?? null, approvedAt: r.approved_at ?? null, closedAt: r.closed_at ?? null,
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
    await this.lockPlans();
    safeMoney(dto.amountMinor);
    const period = resolveBudgetPeriod(dto);
    await this.assertKnownCategory(dto.category?.trim() || '*');
    await this.assertMayWrite(auth, dto.departmentId ?? null);
    let row: { id: string };
    try {
      row = (
        await this.rc.manager.query(
          `INSERT INTO budgets(buyer_org_id, name, category, department_id, period_type,
             period_start, period_end, amount_minor, currency, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [
            auth.org_id, dto.name, dto.category?.trim() || '*', dto.departmentId ?? null,
            period.type, period.start, period.end, dto.amountMinor, BUDGET_CURRENCY, auth.sub,
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
    await this.lockPlans();
    await this.assertBudgetAccess(id, true);
    safeMoney(dto.amountMinor);
    const period = resolveBudgetPeriod(dto);
    await this.assertKnownCategory(dto.category?.trim() || '*');
    await this.assertMayWrite(auth, dto.departmentId ?? null);
    // The amount is money, not a field: changing it writes a revision so "the plan was
    // 500k until March" stays answerable.
    const before = (await this.rc.manager.query(`SELECT amount_minor, status FROM budgets WHERE id=$1`, [id]))[0];
    if (!before) throw new NotFoundException('Budget not found');
    // What may still change depends on where the budget is in its life. A PENDING budget is
    // frozen while someone is reviewing it; a CLOSED period is frozen for good; an APPROVED
    // budget keeps its identity (name, scope, period) and moves only its amount — through a
    // revision that has to say why.
    if (before.status === 'PENDING') {
      throw new ConflictException('This budget is awaiting approval — recall it first to edit');
    }
    if (before.status === 'CLOSED') {
      throw new ConflictException('The period is closed; a closed budget cannot be changed');
    }
    if (before.status === 'APPROVED') {
      const same = (await this.rc.manager.query(
        `SELECT 1 FROM budgets WHERE id=$1 AND name=$2 AND category=$3
           AND department_id IS NOT DISTINCT FROM $4 AND period_start=$5 AND period_end=$6`,
        [id, dto.name, dto.category?.trim() || '*', dto.departmentId ?? null, period.start, period.end],
      ))[0];
      if (!same) {
        throw new ConflictException(
          'An approved budget keeps its name, scope and period — only the amount may be revised. ' +
          'Close it and create a new one if the scope really changed.',
        );
      }
      if (Number(before.amount_minor) !== dto.amountMinor && !dto.reason?.trim()) {
        throw new BadRequestException('Changing an approved amount requires a reason — it goes into the revision history');
      }
    }
    let res: Array<{ id: string }>;
    try {
      res = returnedRows(await this.rc.manager.query(
        `UPDATE budgets SET name=$2, category=$3, department_id=$4, period_type=$5,
           period_start=$6, period_end=$7, amount_minor=$8, currency=$9, updated_at=now()
         WHERE id=$1 RETURNING id`,
        [
          id, dto.name, dto.category?.trim() || '*', dto.departmentId ?? null,
          period.type, period.start, period.end, dto.amountMinor, BUDGET_CURRENCY,
        ],
      ));
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
    await this.assertBudgetAccess(budgetId);
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
  // The plan's shape over time. Returns a row per month of the period always — an unphased
  // budget reports the even split it is actually being judged against, so the editor opens
  // on the current behaviour instead of on an empty form.
  async phasing(budgetId: string) {
    const b = await this.getOne(budgetId);
    const rows = await this.rc.manager.query(
      `SELECT to_char(month_start, 'YYYY-MM') AS month, share_bp FROM budget_phasing
       WHERE budget_id = $1 ORDER BY month_start`,
      [budgetId],
    );
    const months = monthsOfPeriod(b.periodStart, b.periodEnd);
    const saved = new Map<string, number>(rows.map((r: any) => [r.month, Number(r.share_bp)]));
    const evenBp = months.length ? Math.round(10000 / months.length) : 0;
    return {
      budgetId,
      phased: rows.length > 0,
      amountMinor: b.amountMinor,
      months: months.map((m) => {
        const month = m.slice(0, 7);
        const shareBp = saved.get(month) ?? evenBp;
        return { month, shareBp, amountMinor: Math.round((b.amountMinor * shareBp) / 10000) };
      }),
    };
  }

  // Replace the phasing wholesale. Partial edits are refused on purpose: shares only mean
  // anything as a set that adds to 100%, and accepting one month at a time would leave the
  // plan in states that do not.
  async setPhasing(
    budgetId: string,
    months: Array<{ month: string; shareBp: number }>,
    auth: AccessTokenPayload,
  ) {
    await this.lockPlans();
    const b = await this.getOne(budgetId);
    await this.assertMayWrite(auth, b.departmentId ?? null);
    if (b.status === 'CLOSED') {
      throw new ConflictException('A closed period cannot be re-phased — reopen it first');
    }
    const expected = monthsOfPeriod(b.periodStart, b.periodEnd).map((m) => m.slice(0, 7));

    if (months.length) {
      const given = months.map((m) => m.month);
      const dupes = given.filter((m, i) => given.indexOf(m) !== i);
      if (dupes.length) throw new BadRequestException(`Duplicate month(s): ${[...new Set(dupes)].join(', ')}`);
      const stray = given.filter((m) => !expected.includes(m));
      if (stray.length) {
        throw new BadRequestException(
          `Month(s) outside the budget period ${b.periodLabel}: ${stray.join(', ')}`,
        );
      }
      const missing = expected.filter((m) => !given.includes(m));
      if (missing.length) {
        throw new BadRequestException(`Every month of the period must be given; missing: ${missing.join(', ')}`);
      }
      const total = months.reduce((n, m) => n + m.shareBp, 0);
      if (total !== 10000) {
        throw new BadRequestException(
          `Shares must add up to 100.00% — got ${(total / 100).toFixed(2)}%`,
        );
      }
    }

    await this.rc.manager.query(`DELETE FROM budget_phasing WHERE budget_id = $1`, [budgetId]);
    for (const m of months) {
      await this.rc.manager.query(
        `INSERT INTO budget_phasing(buyer_org_id, budget_id, month_start, share_bp, created_by)
         VALUES ($1,$2,$3::date,$4,$5)`,
        [auth.org_id, budgetId, `${m.month}-01`, m.shareBp, auth.sub],
      );
    }
    await this.audit.record(months.length ? 'BUDGET_PHASING_SET' : 'BUDGET_PHASING_CLEARED', 'budget', budgetId, {
      months: months.length,
    });
    return this.phasing(budgetId);
  }

  async rollover(sourceId: string, targetId: string, auth: AccessTokenPayload) {
    await this.lockPlans();
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

    const amount = safeMoney(target.amountMinor + source.remainingMinor);
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

  // Bulk entry. Exporting worked, importing did not — so standing up thirty department
  // budgets meant thirty passes through a one-row form, which is the sort of chore that
  // pushes finance back into a spreadsheet and out of the system.
  //
  // Everything lands as a DRAFT: an import must not be able to put money in force. Rows are
  // validated as a set and the whole file is rejected on the first bad line, because a
  // half-imported plan is worse than none — you cannot tell what is missing.
  async importCsv(text: string, auth: AccessTokenPayload) {
    const lines = text.replace(/^\ufeff/, '').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) throw new BadRequestException('The file is empty');
    const sep = lines[0].includes(';') ? ';' : ',';
    const head = lines[0].split(sep).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
    const need = ['name', 'amount'];
    for (const col of need) {
      if (!head.includes(col)) {
        throw new BadRequestException(`Missing column "${col}". Expected: name, amount, department, category, periodtype, year, quarter, month, reason`);
      }
    }
    const idx = (c: string) => head.indexOf(c);
    const cell = (cols: string[], c: string) => (idx(c) >= 0 ? (cols[idx(c)] ?? '').trim().replace(/^"|"$/g, '') : '');

    const deps = await this.rc.manager.query(`SELECT id, code FROM departments`);
    const depByCode = new Map<string, string>(deps.map((d: any) => [String(d.code).toUpperCase(), d.id]));

    const parsed: Array<{ dto: any; line: number }> = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(sep);
      const line = i + 1;
      const name = cell(cols, 'name');
      if (!name) throw new BadRequestException(`Line ${line}: name is empty`);
      const amount = cell(cols, 'amount').replace(/\s/g, '').replace(',', '.');
      if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
        throw new BadRequestException(`Line ${line}: amount "${cell(cols, 'amount')}" is not a number`);
      }
      const depCode = cell(cols, 'department');
      if (depCode && !depByCode.has(depCode.toUpperCase())) {
        throw new BadRequestException(`Line ${line}: unknown department "${depCode}"`);
      }
      const type = (cell(cols, 'periodtype') || 'YEAR').toUpperCase();
      if (!BUDGET_PERIOD_TYPES.includes(type as BudgetPeriodType)) {
        throw new BadRequestException(`Line ${line}: period type "${type}" must be YEAR, QUARTER or MONTH`);
      }
      const year = Number(cell(cols, 'year') || new Date().getUTCFullYear());
      if (!Number.isInteger(year) || year < 2000) throw new BadRequestException(`Line ${line}: bad year`);
      const [whole = '0', frac = ''] = amount.split('.');
      parsed.push({
        line,
        dto: {
          name,
          category: cell(cols, 'category') || '*',
          departmentId: depCode ? depByCode.get(depCode.toUpperCase()) : undefined,
          periodType: type as BudgetPeriodType,
          periodYear: year,
          periodQuarter: Number(cell(cols, 'quarter')) || undefined,
          periodMonth: Number(cell(cols, 'month')) || undefined,
          amountMinor: Number(whole) * 100 + Number((frac + '00').slice(0, 2)),
          reason: cell(cols, 'reason') || 'Imported',
        },
      });
    }
    if (!parsed.length) throw new BadRequestException('No rows to import');

    // create() already enforces scope, category and overlap rules; a failure aborts the
    // request transaction, so a rejected file leaves nothing behind
    const created = [];
    for (const row of parsed) {
      try {
        created.push(await this.create(row.dto, auth));
      } catch (e: any) {
        throw new BadRequestException(`Line ${row.line}: ${e?.response?.message ?? e?.message ?? 'rejected'}`);
      }
    }
    await this.audit.record('BUDGETS_IMPORTED', 'budget', auth.org_id, { count: created.length });
    return { imported: created.length, budgets: created };
  }

  // ---------- lifecycle ----------
  //
  // Mirrors the discipline a procurement request already had, on the document that commits
  // far more money. Every hop is audited, and approval is subject to segregation of duties:
  // whoever submitted a plan cannot be the one who blesses it.

  private async requireStatus(id: string, allowed: string[]) {
    const b = (await this.rc.manager.query(
      `SELECT id, name, status, submitted_by, period_end FROM budgets WHERE id=$1`, [id],
    ))[0];
    if (!b) throw new NotFoundException('Budget not found');
    if (!allowed.includes(b.status)) {
      throw new ConflictException(`Budget is ${b.status}; expected ${allowed.join(' or ')}`);
    }
    return b;
  }

  // ---------- drill-down ----------
  //
  // The single biggest gap a controller hits: a budget shows "148 030 committed" and there
  // is no way to ask WHICH documents make that up. Every number on the page now opens into
  // the papers behind it, using the same matching rule the totals were built from — so the
  // list can never disagree with the figure it explains.
  async documents(budgetId: string, kind: 'committed' | 'actual' | 'all' = 'all') {
    await this.assertBudgetAccess(budgetId);
    const rows = await this.rc.manager.query(
      `WITH ${this.MATCHED_CTE}
       SELECT 'REQUEST' AS kind, m.id, m.request_no AS doc_no, m.title, m.category,
              m.estimated_total_minor AS amount_minor, m.approved_at AS dated_at,
              m.has_order, m.actual_minor, d.code AS department_code, NULL::text AS status
       FROM matched m
       LEFT JOIN departments d ON d.id = m.department_id
       WHERE m.budget_id = $1
       UNION ALL
       SELECT 'ORDER', o.id, o.po_no, NULL, NULL, o.total_minor, o.spent_at,
              true, o.total_minor, d.code, NULL
       FROM matched_orders o
       LEFT JOIN departments d ON d.id = o.department_id
       WHERE o.budget_id = $1
       ORDER BY dated_at DESC`,
      [budgetId],
    );
    return rows
      .map((r: any) => ({
        kind: r.kind,
        id: r.id,
        docNo: r.doc_no,
        title: r.title,
        category: r.category === '*' ? null : r.category,
        departmentCode: r.department_code ?? null,
        datedAt: r.dated_at,
        // A request that already turned into an order contributes its ORDER value; the
        // estimate stops counting, exactly as the totals do it.
        bucket: r.kind === 'ORDER' || r.has_order ? 'actual' : 'committed',
        amountMinor: r.kind === 'ORDER' || r.has_order ? Number(r.actual_minor) : Number(r.amount_minor),
      }))
      .filter((r: any) => kind === 'all' || r.bucket === kind);
  }

  async submit(id: string, auth: AccessTokenPayload) {
    await this.lockPlans();
    await this.assertBudgetAccess(id, true);
    await this.requireStatus(id, ['DRAFT']);
    await this.rc.manager.query(
      `UPDATE budgets SET status='PENDING', submitted_by=$2, submitted_at=now(), updated_at=now() WHERE id=$1`,
      [id, auth.sub],
    );
    await this.audit.record('BUDGET_SUBMITTED', 'budget', id, {});
    return this.getOne(id);
  }

  // Pull a plan back out of review — the way to edit something already sent.
  async recall(id: string, auth: AccessTokenPayload) {
    await this.lockPlans();
    await this.assertBudgetAccess(id, true);
    await this.requireStatus(id, ['PENDING']);
    await this.rc.manager.query(
      `UPDATE budgets SET status='DRAFT', submitted_by=NULL, submitted_at=NULL, updated_at=now() WHERE id=$1`,
      [id],
    );
    await this.audit.record('BUDGET_RECALLED', 'budget', id, { by: auth.sub });
    return this.getOne(id);
  }

  async approveBudget(id: string, auth: AccessTokenPayload) {
    await this.lockPlans();
    const b = await this.requireStatus(id, ['PENDING']);
    // Four-eyes: whoever put the number forward must not be the one who blesses it. But a
    // small buyer may have exactly one person who can approve at all, and a rule that locks
    // the only admin out of their own budgets is a rule nobody keeps — they would go around
    // it. So the check applies only when somebody else COULD act, and a genuine
    // self-approval is recorded as such instead of being quietly allowed.
    let selfApproved = false;
    if (b.submitted_by && b.submitted_by === auth.sub) {
      const others = await this.rc.manager.query(
        `SELECT 1 FROM memberships WHERE org_id = $1 AND user_id <> $2
           AND role IN ('BUYER_ADMIN','BUYER_APPROVER','BUYER_FINANCE')
           AND EXISTS (SELECT 1 FROM organization_users u WHERE u.id=memberships.user_id AND u.status='ACTIVE') LIMIT 1`,
        [auth.org_id, auth.sub],
      );
      if (others.length) {
        throw new ForbiddenException('You cannot approve a budget you submitted (segregation of duties)');
      }
      selfApproved = true;
    }
    await this.rc.manager.query(
      `UPDATE budgets SET status='APPROVED', approved_by=$2, approved_at=now(), updated_at=now() WHERE id=$1`,
      [id, auth.sub],
    );
    await this.audit.record('BUDGET_APPROVED', 'budget', id, { name: b.name, self_approved: selfApproved });
    return this.getOne(id);
  }

  async rejectBudget(id: string, auth: AccessTokenPayload, reason: string) {
    await this.lockPlans();
    const b = await this.requireStatus(id, ['PENDING']);
    if (b.submitted_by && b.submitted_by === auth.sub) {
      throw new ForbiddenException('You cannot decide on a budget you submitted (segregation of duties)');
    }
    await this.rc.manager.query(
      `UPDATE budgets SET status='DRAFT', submitted_by=NULL, submitted_at=NULL, updated_at=now() WHERE id=$1`,
      [id],
    );
    await this.audit.record('BUDGET_REJECTED', 'budget', id, { reason });
    return this.getOne(id);
  }

  // Closing signs the period off: the plan stops moving, but the budget keeps counting its
  // spend, so historical reports stay whole. Refused before the period is over — a closed
  // budget that can still receive commitments would be a lie.
  async close(id: string, auth: AccessTokenPayload) {
    await this.lockPlans();
    const b = await this.requireStatus(id, ['APPROVED']);
    const today = new Date().toISOString().slice(0, 10);
    if (iso(new Date(b.period_end)) >= today) {
      throw new BadRequestException('The period has not ended yet — a budget can only be closed after its last day');
    }
    // Freeze what the budget WAS at sign-off. Read the live figures first, then store them:
    // from here on this budget reports the snapshot, so cancelling an old request or
    // re-dating an order can no longer move a number finance has already signed.
    const live = await this.getOne(id);
    await this.rc.manager.query(
      `UPDATE budgets SET status='CLOSED', closed_by=$2, closed_at=now(), updated_at=now(),
         closed_committed_minor=$3, closed_actual_minor=$4
       WHERE id=$1`,
      [id, auth.sub, live.committedMinor, live.actualMinor],
    );
    await this.audit.record('BUDGET_CLOSED', 'budget', id, {
      name: b.name, committed_minor: live.committedMinor, actual_minor: live.actualMinor,
    });
    return this.getOne(id);
  }

  // Reopening exists because closings happen by mistake; it is audited exactly like the
  // close, so the pair is always visible together in the trail.
  async reopen(id: string, auth: AccessTokenPayload, reason: string) {
    await this.lockPlans();
    const b = await this.requireStatus(id, ['CLOSED']);
    await this.rc.manager.query(
      `UPDATE budgets SET status='APPROVED', closed_by=NULL, closed_at=NULL, updated_at=now(),
         closed_committed_minor=NULL, closed_actual_minor=NULL
       WHERE id=$1`,
      [id],
    );
    await this.audit.record('BUDGET_REOPENED', 'budget', id, { name: b.name, reason, by: auth.sub });
    return this.getOne(id);
  }

  async remove(id: string) {
    await this.lockPlans();
    await this.assertBudgetAccess(id, true);
    // Only a draft is disposable. Anything that has been approved is part of the financial
    // record — it gets closed, not deleted.
    await this.requireStatus(id, ['DRAFT']);
    const res = returnedRows(await this.rc.manager.query(`DELETE FROM budgets WHERE id=$1 RETURNING id`, [id]));
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
    await this.assertBudgetAccess(id);
    const rows = await this.rc.manager.query(
      `WITH ${this.MATCHED_CTE}
       SELECT b.id, b.name, b.category, b.department_id, b.period_type, b.status,
              b.submitted_at, b.approved_at, b.closed_at,
              b.closed_committed_minor, b.closed_actual_minor,
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

  // Budgets for 1C. Deliberately not the same file as /budgets/export: that one is the
  // whole picture for a human (plan, commitments, actual, remainder), while an accounting
  // system loads a PLAN broken down by period and analytic dimension. Commitments and
  // actuals are not exported here on purpose — 1C already holds the facts, and splitting a
  // procurement-side commitment across months would be an invention, not a figure.
  //
  // One row per month per budget: a phased budget contributes the share finance entered, an
  // unphased one an even split. The last month absorbs the rounding remainder so the rows
  // add up to the plan exactly — an import that is off by a few qəpik gets rejected.
  async export1cCsv(filter: Parameters<BudgetsService['list']>[0] = {}): Promise<string> {
    const budgets = await this.list(filter);
    const phasing = new Map<string, Map<string, number>>();
    if (budgets.length) {
      const rows = await this.rc.manager.query(
        `SELECT budget_id, to_char(month_start, 'YYYY-MM') AS month, share_bp FROM budget_phasing
         WHERE budget_id = ANY($1::uuid[])`,
        [budgets.map((b: any) => b.id)],
      );
      for (const r of rows) {
        const cur = phasing.get(r.budget_id) ?? new Map<string, number>();
        cur.set(r.month, Number(r.share_bp));
        phasing.set(r.budget_id, cur);
      }
    }

    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const money = (m: number) => (m / 100).toFixed(2);
    const header = [
      'Период', 'Дата начала', 'Дата конца', 'Подразделение', 'Статья',
      'Бюджет', 'Статус', 'Сумма', 'Валюта',
    ];
    const lines: string[] = [];
    for (const b of budgets) {
      const months = monthsOfPeriod(b.periodStart, b.periodEnd);
      const shares = phasing.get(b.id);
      let allocated = 0;
      months.forEach((first, i) => {
        const month = first.slice(0, 7);
        const last = i === months.length - 1;
        const amount = last
          ? b.amountMinor - allocated // the remainder, so the file totals the plan exactly
          : shares
            ? Math.round((b.amountMinor * (shares.get(month) ?? 0)) / 10000)
            : Math.round(b.amountMinor / months.length);
        allocated += amount;
        const monthEnd = new Date(`${first}T00:00:00Z`);
        monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
        monthEnd.setUTCDate(0);
        lines.push([
          month, first, iso(monthEnd),
          b.departmentCode ?? '', b.category === '*' ? '' : b.category,
          b.name, b.status, money(amount), b.currency,
        ].map(esc).join(';'));
      });
    }
    return '\ufeff' + [header.map(esc).join(';'), ...lines].join('\r\n'); // BOM so 1C reads UTF-8
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
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_FINANCE', 'BUYER_USER')
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
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_FINANCE')
  unbudgeted(@Query('from') from?: string, @Query('to') to?: string) {
    return this.budgets.unbudgeted({ from: from || undefined, to: to || undefined });
  }

  // Integrations → 1C: the plan by month and dimension, ready to import.
  @Get('export/1c')
  @Roles('BUYER_ADMIN', 'BUYER_FINANCE', 'BUYER_APPROVER')
  async export1c(
    @Res() res: Response,
    @Query('year') year?: string,
    @Query('periodType') periodType?: string,
    @Query('departmentId') departmentId?: string,
  ) {
    const csv = await this.budgets.export1cCsv({
      year: year ? Number(year) : undefined,
      periodType: periodType || undefined,
      departmentId: departmentId || undefined,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="budgets-1c.csv"');
    res.send(csv);
  }

  @Get('export')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_FINANCE')
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
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_FINANCE', 'BUYER_USER')
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

  // Bulk-create drafts from a CSV. The body is the file's text, so curl and a file input
  // work the same way.
  @Post('import')
  @Roles('BUYER_ADMIN', 'BUYER_FINANCE')
  importCsv(@Body() body: ImportCsvDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.importCsv(body.csv, auth);
  }

  @Get('policy')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_FINANCE', 'BUYER_USER')
  policy() {
    return this.budgets.getPolicy();
  }

  @Put('policy')
  @Roles('BUYER_ADMIN', 'BUYER_FINANCE')
  setPolicy(@Body() dto: BudgetPolicyDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.setPolicy(dto, auth);
  }

  // What approving this request would do to its budget — for the approve dialog.
  @Get('impact/:requestId')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_FINANCE', 'BUYER_USER')
  impact(@Param('requestId') requestId: string) {
    return this.budgets.impactFor(requestId);
  }

  @Post()
  @Roles('BUYER_ADMIN', 'BUYER_FINANCE', 'BUYER_USER')
  create(@Body() dto: UpsertBudgetDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.create(dto, auth);
  }

  @Put(':id')
  @Roles('BUYER_ADMIN', 'BUYER_FINANCE', 'BUYER_USER')
  update(@Param('id') id: string, @Body() dto: UpsertBudgetDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.update(id, dto, auth);
  }

  // What makes up this budget's numbers — ?kind=committed|actual narrows it.
  @Get(':id/documents')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_FINANCE', 'BUYER_USER')
  documents(@Param('id') id: string, @Query('kind') kind?: 'committed' | 'actual') {
    return this.budgets.documents(id, kind ?? 'all');
  }

  @Get(':id/phasing')
  @Roles('BUYER_ADMIN', 'BUYER_FINANCE', 'BUYER_APPROVER', 'BUYER_USER')
  phasing(@Param('id') id: string) {
    return this.budgets.phasing(id);
  }

  @Put(':id/phasing')
  @Roles('BUYER_ADMIN', 'BUYER_FINANCE', 'BUYER_USER')
  setPhasing(@Param('id') id: string, @Body() dto: SetPhasingDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.setPhasing(id, dto.months, auth);
  }

  @Get(':id/revisions')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_FINANCE', 'BUYER_USER')
  revisions(@Param('id') id: string) {
    return this.budgets.revisions(id);
  }

  // Carry this budget's unspent remainder into another period's budget.
  @Post(':id/rollover')
  @Roles('BUYER_ADMIN', 'BUYER_FINANCE')
  rollover(@Param('id') id: string, @Body() dto: RolloverDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.rollover(dto.sourceBudgetId, id, auth);
  }

  @Post(':id/submit')
  @Roles('BUYER_ADMIN', 'BUYER_FINANCE', 'BUYER_USER')
  submit(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.submit(id, auth);
  }

  @Post(':id/recall')
  @Roles('BUYER_ADMIN', 'BUYER_FINANCE', 'BUYER_USER')
  recall(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.recall(id, auth);
  }

  @Post(':id/approve')
  @Roles('BUYER_ADMIN', 'BUYER_FINANCE', 'BUYER_APPROVER')
  approveBudget(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.approveBudget(id, auth);
  }

  @Post(':id/reject')
  @Roles('BUYER_ADMIN', 'BUYER_FINANCE', 'BUYER_APPROVER')
  rejectBudget(@Param('id') id: string, @Body() body: ReasonDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.rejectBudget(id, auth, body.reason);
  }

  @Post(':id/close')
  @Roles('BUYER_ADMIN', 'BUYER_FINANCE')
  close(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.close(id, auth);
  }

  @Post(':id/reopen')
  @Roles('BUYER_ADMIN', 'BUYER_FINANCE')
  reopen(@Param('id') id: string, @Body() body: ReasonDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.reopen(id, auth, body.reason);
  }

  @Delete(':id')
  @Roles('BUYER_ADMIN', 'BUYER_FINANCE', 'BUYER_USER')
  remove(@Param('id') id: string) {
    return this.budgets.remove(id);
  }
}

// Weekly digest of budgets running hot. Monitoring was entirely passive: the only signal
// was a notification fired at the instant somebody approved a request, which reaches you
// once the money is already committed. A controller wants the list BEFORE the week starts.
//
// Runs without a request context, so it reads through the injected DataSource and speaks to
// each org explicitly — the same seam the follow-up ticker uses.
@Injectable()
export class BudgetDigestScheduler {
  private readonly logger = new Logger(BudgetDigestScheduler.name);
  constructor(private readonly ds: DataSource) {}

  @Cron(CronExpression.EVERY_WEEK)
  async tick(): Promise<number> {
    // Budgets in force whose period covers today, spending faster than the calendar by more
    // than the org's warn threshold. The pace maths mirrors the rollup: share spent vs share
    // of the period gone.
    const hot: Array<{
      buyer_org_id: string; id: string; name: string; department_code: string | null;
      owner_user_id: string | null; used_pct: number; elapsed_pct: number;
    }> = await this.ds.query(`
      WITH live AS (
        SELECT b.id, b.buyer_org_id, b.name, b.amount_minor, b.period_start, b.period_end,
               d.code AS department_code, d.owner_user_id,
               COALESCE(p.warn_pct, 80) AS warn_pct
        FROM budgets b
        LEFT JOIN departments d ON d.id = b.department_id
        LEFT JOIN budget_policies p ON p.buyer_org_id = b.buyer_org_id
        WHERE b.status = 'APPROVED'
          AND now() BETWEEN b.period_start::timestamptz AND (b.period_end + 1)::timestamptz
      ),
      spend AS (
        SELECT l.*, COALESCE((
          SELECT sum(pr.estimated_total_minor)::bigint FROM procurement_requests pr
          WHERE pr.status = 'APPROVED' AND pr.approved_at IS NOT NULL
            AND pr.approved_at >= l.period_start::timestamptz
            AND pr.approved_at < (l.period_end + 1)::timestamptz
            AND pr.owner_org_id = l.buyer_org_id
        ), 0) AS used_minor
        FROM live l
      )
      SELECT buyer_org_id, id, name, department_code, owner_user_id,
             round((used_minor::numeric / NULLIF(amount_minor, 0)) * 100, 1) AS used_pct,
             round((EXTRACT(EPOCH FROM (now() - period_start::timestamptz))
                    / NULLIF(EXTRACT(EPOCH FROM ((period_end + 1)::timestamptz - period_start::timestamptz)), 0)) * 100, 1) AS elapsed_pct
      FROM spend
      WHERE amount_minor > 0
        AND (used_minor::numeric / amount_minor) * 100 >= warn_pct`);

    for (const b of hot) {
      // Addressed to whoever answers for the cost centre, exactly like the threshold
      // warning; with nobody named it goes to the org so it is not lost.
      await this.ds.query(`SELECT app_notify($1, $2, $3, $4::jsonb)`, [
        b.buyer_org_id, b.owner_user_id, 'BUDGET_WEEKLY_DIGEST',
        JSON.stringify({
          title: `${b.department_code ? `${b.department_code} · ` : ''}${b.name}`,
          budget: b.name,
          utilization: `${b.used_pct}%`,
          status: `elapsed ${b.elapsed_pct}%`,
        }),
      ]).catch((e) => this.logger.warn(`digest for ${b.id} failed: ${e?.message}`));
    }
    if (hot.length) this.logger.log(`budget digest: ${hot.length} budget(s) running hot`);
    return hot.length;
  }
}

@Module({
  imports: [NotifyModule],
  controllers: [BudgetsController],
  providers: [BudgetsService, BudgetDigestScheduler],
  exports: [BudgetsService],
})
export class BudgetsModule {}
