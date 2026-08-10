import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Injectable, Module,
  NotFoundException, Param, Post, Put, Query,
} from '@nestjs/common';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Length, Max, Min, MinLength } from 'class-validator';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { CurrentUser, RequiresFeature, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';

export const BUDGET_PERIOD_TYPES = ['YEAR', 'QUARTER', 'MONTH'] as const;
export type BudgetPeriodType = (typeof BUDGET_PERIOD_TYPES)[number];

class UpsertBudgetDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() category?: string; // omit / '*' = all categories
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

  // committed = Σ estimated_total of APPROVED requests matching this budget's scope.
  // Dated by APPROVAL, not creation: a request raised in December and approved in January
  // is January's commitment. `period_end + 1` keeps the last day of the range inclusive.
  private readonly COMMITTED_SUBQUERY = `
    COALESCE((SELECT sum(pr.estimated_total_minor)::bigint FROM procurement_requests pr
              WHERE pr.status = 'APPROVED' AND pr.currency = b.currency
                AND pr.approved_at IS NOT NULL
                AND pr.approved_at >= b.period_start::timestamptz
                AND pr.approved_at < (b.period_end + 1)::timestamptz
                AND (b.category = '*' OR pr.category = b.category)), 0) AS committed_minor`;

  // Filters: a plain year (every budget whose range starts in it) or an explicit
  // from/to window, optionally narrowed to one period type.
  async list(filter: { year?: number; periodType?: string; from?: string; to?: string } = {}) {
    const rows = await this.rc.manager.query(
      `SELECT b.id, b.name, b.category, b.period_year, b.period_type, b.period_start, b.period_end,
              b.amount_minor, b.currency, b.created_at,
              ${this.COMMITTED_SUBQUERY}
       FROM budgets b
       WHERE ($1::int IS NULL OR EXTRACT(YEAR FROM b.period_start)::int = $1)
         AND ($2::text IS NULL OR b.period_type = $2)
         AND ($3::date IS NULL OR b.period_end >= $3)
         AND ($4::date IS NULL OR b.period_start <= $4)
       ORDER BY b.period_start DESC, b.name`,
      [filter.year ?? null, filter.periodType ?? null, filter.from ?? null, filter.to ?? null],
    );
    return rows.map((r: any) => this.shape(r));
  }

  private shape(r: any) {
    const amount = Number(r.amount_minor);
    const committed = Number(r.committed_minor);
    const start = iso(new Date(r.period_start));
    const end = iso(new Date(r.period_end));
    return {
      id: r.id, name: r.name, category: r.category, periodYear: r.period_year,
      periodType: r.period_type, periodStart: start, periodEnd: end,
      periodLabel: budgetPeriodLabel(r.period_type, start),
      currency: r.currency, amountMinor: amount, committedMinor: committed,
      remainingMinor: amount - committed,
      utilizationPct: amount > 0 ? Math.round((committed / amount) * 1000) / 10 : 0,
      createdAt: r.created_at,
    };
  }

  async create(dto: UpsertBudgetDto, auth: AccessTokenPayload) {
    const period = resolveBudgetPeriod(dto);
    let row: { id: string };
    try {
      row = (
        await this.rc.manager.query(
          `INSERT INTO budgets(buyer_org_id, name, category, period_year, period_type, period_start, period_end,
             amount_minor, currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            auth.org_id, dto.name, dto.category?.trim() || '*', period.year, period.type,
            period.start, period.end, dto.amountMinor, dto.currency ?? 'AZN',
          ],
        )
      )[0];
    } catch (e: any) {
      // one budget per (org, name, period start) — a clean 409, not a 500
      if (e?.code === '23505') {
        throw new ConflictException(
          `A budget named "${dto.name}" already exists for ${budgetPeriodLabel(period.type, period.start)}`,
        );
      }
      throw e;
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
        `UPDATE budgets SET name=$2, category=$3, period_year=$4, period_type=$5, period_start=$6, period_end=$7,
           amount_minor=$8, currency=$9, updated_at=now()
         WHERE id=$1 RETURNING id`,
        [
          id, dto.name, dto.category?.trim() || '*', period.year, period.type,
          period.start, period.end, dto.amountMinor, dto.currency ?? 'AZN',
        ],
      );
    } catch (e: any) {
      if (e?.code === '23505') {
        throw new ConflictException(
          `A budget named "${dto.name}" already exists for ${budgetPeriodLabel(period.type, period.start)}`,
        );
      }
      throw e;
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

  private async getOne(id: string) {
    const found = (await this.list()).find((b: { id: string }) => b.id === id);
    if (!found) throw new NotFoundException('Budget not found');
    return found;
  }

  // Non-blocking: returns budgets that this (already-APPROVED) request has tipped over.
  // Called from request approval; never throws, so it can't break the approval flow.
  async warningsForRequest(req: {
    category: string | null;
    currency: string;
    approved_at: string | Date | null;
  }): Promise<BudgetWarning[]> {
    if (!req.approved_at) return [];
    const rows = await this.rc.manager.query(
      `SELECT b.id, b.name, b.category, b.period_year, b.period_type, b.period_start,
              b.amount_minor, b.currency,
              ${this.COMMITTED_SUBQUERY}
       FROM budgets b
       WHERE $1::timestamptz >= b.period_start::timestamptz
         AND $1::timestamptz < (b.period_end + 1)::timestamptz
         AND b.currency = $2
         AND (b.category = '*' OR b.category = $3)`,
      [req.approved_at, req.currency, req.category],
    );
    return rows
      .filter((r: any) => Number(r.committed_minor) > Number(r.amount_minor))
      .map((r: any) => ({
        budgetId: r.id, name: r.name, category: r.category, periodYear: r.period_year,
        periodType: r.period_type,
        periodLabel: budgetPeriodLabel(r.period_type, iso(new Date(r.period_start))),
        currency: r.currency, amountMinor: Number(r.amount_minor),
        committedMinor: Number(r.committed_minor),
        overByMinor: Number(r.committed_minor) - Number(r.amount_minor),
      }));
  }
}

@Controller('budgets')
@RequiresFeature('controls.budgets')
export class BudgetsController {
  constructor(private readonly budgets: BudgetsService) {}

  @Get()
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  list(
    @Query('year') year?: string,
    @Query('periodType') periodType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.budgets.list({
      year: year ? Number(year) : undefined,
      periodType: periodType || undefined,
      from: from || undefined,
      to: to || undefined,
    });
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
