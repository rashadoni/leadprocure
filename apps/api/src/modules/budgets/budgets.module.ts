import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Injectable, Module,
  NotFoundException, Param, Post, Put, Query,
} from '@nestjs/common';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min, MinLength } from 'class-validator';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { CurrentUser, RequiresFeature, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';

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
  @IsOptional() @IsString() @Length(3, 3) currency?: string;
}

export interface BudgetPeriod {
  type: BudgetPeriodType;
  start: string; // YYYY-MM-DD, inclusive
  end: string;   // YYYY-MM-DD, inclusive
  year: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

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
        HAVING count(*) > 0
      ) po ON true
      WHERE pr.status = 'APPROVED' AND pr.approved_at IS NOT NULL
    )`;

  // Plan / Commitment / Actual, with commitment and actual mutually exclusive per request.
  private readonly COMMITTED_JOIN = `
    LEFT JOIN (
      SELECT budget_id,
             sum(CASE WHEN has_order THEN 0 ELSE estimated_total_minor END)::bigint AS committed,
             sum(actual_minor)::bigint AS actual
      FROM matched WHERE budget_id IS NOT NULL GROUP BY budget_id
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
       SELECT b.id, b.name, b.category, b.department_id, b.period_year, b.period_type,
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
       SELECT m.id, m.request_no, m.title, m.category, m.currency, m.estimated_total_minor,
              m.approved_at, d.code AS department_code
       FROM matched m
       LEFT JOIN departments d ON d.id = m.department_id
       WHERE m.budget_id IS NULL
         AND ($1::date IS NULL OR m.approved_at >= $1::timestamptz)
         AND ($2::date IS NULL OR m.approved_at < ($2::date + 1)::timestamptz)
       ORDER BY m.approved_at DESC`,
      [filter.from ?? null, filter.to ?? null],
    );
    return rows.map((r: any) => ({
      requestId: r.id, requestNo: r.request_no, title: r.title,
      category: r.category === '*' ? null : r.category,
      departmentCode: r.department_code ?? null,
      currency: r.currency, amountMinor: Number(r.estimated_total_minor),
      approvedAt: r.approved_at,
    }));
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
      id: r.id, name: r.name, category: r.category, periodYear: r.period_year,
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

  async create(dto: UpsertBudgetDto, auth: AccessTokenPayload) {
    const period = resolveBudgetPeriod(dto);
    let row: { id: string };
    try {
      row = (
        await this.rc.manager.query(
          `INSERT INTO budgets(buyer_org_id, name, category, department_id, period_year, period_type,
             period_start, period_end, amount_minor, currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [
            auth.org_id, dto.name, dto.category?.trim() || '*', dto.departmentId ?? null,
            period.year, period.type, period.start, period.end, dto.amountMinor, dto.currency ?? 'AZN',
          ],
        )
      )[0];
    } catch (e: any) {
      throw this.friendlyConflict(e, dto, period);
    }
    await this.audit.record('BUDGET_CREATED', 'budget', row.id, {
      name: dto.name, periodType: period.type, periodStart: period.start,
    });
    return this.getOne(row.id);
  }

  async update(id: string, dto: UpsertBudgetDto) {
    const period = resolveBudgetPeriod(dto);
    let res: Array<{ id: string }>;
    try {
      res = await this.rc.manager.query(
        `UPDATE budgets SET name=$2, category=$3, department_id=$4, period_year=$5, period_type=$6,
           period_start=$7, period_end=$8, amount_minor=$9, currency=$10, updated_at=now()
         WHERE id=$1 RETURNING id`,
        [
          id, dto.name, dto.category?.trim() || '*', dto.departmentId ?? null, period.year,
          period.type, period.start, period.end, dto.amountMinor, dto.currency ?? 'AZN',
        ],
      );
    } catch (e: any) {
      throw this.friendlyConflict(e, dto, period);
    }
    if (!res[0]) throw new NotFoundException('Budget not found');
    await this.audit.record('BUDGET_UPDATED', 'budget', id, { name: dto.name });
    return this.getOne(id);
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

  private async getOne(id: string) {
    const found = (await this.list()).find((b: { id: string }) => b.id === id);
    if (!found) throw new NotFoundException('Budget not found');
    return found;
  }

  // Non-blocking: returns budgets that this (already-APPROVED) request has tipped over.
  // Called from request approval; never throws, so it can't break the approval flow.
  async warningsForRequest(req: { id: string; approved_at: string | Date | null }): Promise<BudgetWarning[]> {
    if (!req.approved_at) return [];
    // One request charges exactly one budget, so this returns at most one warning — but
    // the array shape is kept: callers (and the UI) already treat it as a list.
    const rows = await this.rc.manager.query(
      `WITH ${this.MATCHED_CTE}
       SELECT b.id, b.name, b.category, b.period_year, b.period_type, b.period_start,
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
        budgetId: r.id, name: r.name, category: r.category, periodYear: r.period_year,
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

  @Post()
  @Roles('BUYER_ADMIN')
  create(@Body() dto: UpsertBudgetDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.budgets.create(dto, auth);
  }

  @Put(':id')
  @Roles('BUYER_ADMIN')
  update(@Param('id') id: string, @Body() dto: UpsertBudgetDto) {
    return this.budgets.update(id, dto);
  }

  @Delete(':id')
  @Roles('BUYER_ADMIN')
  remove(@Param('id') id: string) {
    return this.budgets.remove(id);
  }
}

@Module({
  controllers: [BudgetsController],
  providers: [BudgetsService],
  exports: [BudgetsService],
})
export class BudgetsModule {}
