import {
  Body, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Post, Put, Query,
} from '@nestjs/common';
import { IsInt, IsOptional, IsString, Length, Min, MinLength } from 'class-validator';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { CurrentUser, RequiresFeature, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';

class UpsertBudgetDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() category?: string; // omit / '*' = all categories
  @IsInt() @Min(2000) periodYear!: number;
  @IsInt() @Min(0) amountMinor!: number;
  @IsOptional() @IsString() @Length(3, 3) currency?: string;
}

export interface BudgetWarning {
  budgetId: string;
  name: string;
  category: string;
  periodYear: number;
  currency: string;
  amountMinor: number;
  committedMinor: number;
  overByMinor: number;
}

// Encumbrance budgets: APPROVED procurement requests commit against the matching budget
// (category + calendar year + currency). Utilization is derived, never stored, so it always
// reflects current request state. All queries run under the buyer's RLS context.
@Injectable()
export class BudgetsService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  // committed = Σ estimated_total of APPROVED requests matching this budget's scope.
  private readonly COMMITTED_SUBQUERY = `
    COALESCE((SELECT sum(pr.estimated_total_minor)::bigint FROM procurement_requests pr
              WHERE pr.status = 'APPROVED' AND pr.currency = b.currency
                AND EXTRACT(YEAR FROM pr.created_at)::int = b.period_year
                AND (b.category = '*' OR pr.category = b.category)), 0) AS committed_minor`;

  async list(year?: number) {
    const rows = await this.rc.manager.query(
      `SELECT b.id, b.name, b.category, b.period_year, b.amount_minor, b.currency, b.created_at,
              ${this.COMMITTED_SUBQUERY}
       FROM budgets b
       WHERE ($1::int IS NULL OR b.period_year = $1)
       ORDER BY b.period_year DESC, b.name`,
      [year ?? null],
    );
    return rows.map((r: any) => {
      const amount = Number(r.amount_minor);
      const committed = Number(r.committed_minor);
      return {
        id: r.id, name: r.name, category: r.category, periodYear: r.period_year,
        currency: r.currency, amountMinor: amount, committedMinor: committed,
        remainingMinor: amount - committed,
        utilizationPct: amount > 0 ? Math.round((committed / amount) * 1000) / 10 : 0,
        createdAt: r.created_at,
      };
    });
  }

  async create(dto: UpsertBudgetDto, auth: AccessTokenPayload) {
    const row = (
      await this.rc.manager.query(
        `INSERT INTO budgets(buyer_org_id, name, category, period_year, amount_minor, currency)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [auth.org_id, dto.name, dto.category?.trim() || '*', dto.periodYear, dto.amountMinor, dto.currency ?? 'AZN'],
      )
    )[0];
    await this.audit.record('BUDGET_CREATED', 'budget', row.id, { name: dto.name, periodYear: dto.periodYear });
    return this.getOne(row.id);
  }

  async update(id: string, dto: UpsertBudgetDto) {
    const res = await this.rc.manager.query(
      `UPDATE budgets SET name=$2, category=$3, period_year=$4, amount_minor=$5, currency=$6, updated_at=now()
       WHERE id=$1 RETURNING id`,
      [id, dto.name, dto.category?.trim() || '*', dto.periodYear, dto.amountMinor, dto.currency ?? 'AZN'],
    );
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
    created_at: string | Date;
  }): Promise<BudgetWarning[]> {
    const rows = await this.rc.manager.query(
      `SELECT b.id, b.name, b.category, b.period_year, b.amount_minor, b.currency,
              ${this.COMMITTED_SUBQUERY}
       FROM budgets b
       WHERE b.period_year = EXTRACT(YEAR FROM $1::timestamptz)::int
         AND b.currency = $2
         AND (b.category = '*' OR b.category = $3)`,
      [req.created_at, req.currency, req.category],
    );
    return rows
      .filter((r: any) => Number(r.committed_minor) > Number(r.amount_minor))
      .map((r: any) => ({
        budgetId: r.id, name: r.name, category: r.category, periodYear: r.period_year,
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
  list(@Query('year') year?: string) {
    return this.budgets.list(year ? Number(year) : undefined);
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
