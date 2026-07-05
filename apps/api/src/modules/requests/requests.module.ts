import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { ProcurementMethod } from '@leadprocure/shared';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';

class ItemDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() description?: string;
  @IsInt() @Min(1) qty!: number;
  @IsOptional() @IsString() uom?: string;
  @IsInt() @Min(0) estUnitPriceMinor!: number;
  @IsOptional() @IsInt() vatRateBp?: number;
}
class UpsertRequestDto {
  @IsString() @MinLength(3) title!: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsIn(['INCLUSIVE', 'EXCLUSIVE']) vatMode?: 'INCLUSIVE' | 'EXCLUSIVE';
  @IsArray() @ValidateNested({ each: true }) @Type(() => ItemDto) items!: ItemDto[];
}

@Injectable()
export class RequestsService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  async list(q?: string) {
    return this.rc.manager.query(
      `SELECT pr.id, pr.request_no, pr.title, pr.status, pr.estimated_total_minor, pr.currency, pr.category,
              pr.method_resolved, pr.created_at,
              (SELECT count(*)::int FROM approval_steps s WHERE s.request_id = pr.id) AS steps_total,
              (SELECT count(*)::int FROM approval_steps s WHERE s.request_id = pr.id AND s.status = 'APPROVED') AS steps_done,
              (SELECT s.approver_role FROM approval_steps s WHERE s.request_id = pr.id AND s.status = 'SUBMITTED'
               ORDER BY s.step_no LIMIT 1) AS current_role
       FROM procurement_requests pr
       WHERE ($1::text IS NULL OR pr.title ILIKE '%' || $1 || '%' OR pr.request_no ILIKE '%' || $1 || '%')
       ORDER BY pr.created_at DESC`,
      [q ?? null],
    );
  }

  async get(id: string) {
    const m = this.rc.manager;
    const rows = await m.query(`SELECT * FROM procurement_requests WHERE id = $1`, [id]);
    if (!rows.length) throw new NotFoundException('Request not found');
    const items = await m.query(
      `SELECT * FROM request_items WHERE request_id = $1 ORDER BY line_no`,
      [id],
    );
    const approvals = await m.query(
      `SELECT step_no, approver_role, status, acted_at FROM approval_steps WHERE request_id = $1 ORDER BY step_no`,
      [id],
    );
    return { ...rows[0], items, approvals };
  }

  async getApprovalPolicies() {
    return this.rc.manager.query(
      `SELECT id, min_amount_minor, max_amount_minor, steps FROM approval_policies ORDER BY min_amount_minor`,
    );
  }

  async replaceApprovalPolicies(
    orgId: string,
    policies: Array<{ minAmountMinor: number; maxAmountMinor: number | null; steps: Array<{ order: number; role: string }> }>,
  ) {
    const m = this.rc.manager;
    await m.query(`DELETE FROM approval_policies`);
    for (const p of policies) {
      await m.query(
        `INSERT INTO approval_policies(buyer_org_id, min_amount_minor, max_amount_minor, steps) VALUES ($1,$2,$3,$4)`,
        [orgId, p.minAmountMinor, p.maxAmountMinor, JSON.stringify(p.steps)],
      );
    }
    return this.getApprovalPolicies();
  }

  async create(dto: UpsertRequestDto, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    const countRows = await m.query(`SELECT count(*)::int AS n FROM procurement_requests`);
    const requestNo = `REQ-${new Date().getFullYear()}-${String(countRows[0].n + 1).padStart(4, '0')}`;
    const total = this.computeTotal(dto.items);
    const req = (
      await m.query(
        `INSERT INTO procurement_requests(owner_org_id, request_no, title, category, vat_mode,
           estimated_total_minor, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [auth.org_id, requestNo, dto.title, dto.category ?? '*', dto.vatMode ?? 'EXCLUSIVE', total, auth.sub],
      )
    )[0];
    await this.insertItems(req.id, auth.org_id, dto.items);
    return this.get(req.id);
  }

  async update(id: string, dto: UpsertRequestDto, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    const req = await this.requireStatus(id, ['DRAFT']);
    const total = this.computeTotal(dto.items);
    await m.query(
      `UPDATE procurement_requests
       SET title=$2, category=$3, vat_mode=$4, estimated_total_minor=$5, version=version+1, updated_at=now()
       WHERE id=$1`,
      [id, dto.title, dto.category ?? req.category, dto.vatMode ?? req.vat_mode, total],
    );
    await m.query(`DELETE FROM request_items WHERE request_id = $1`, [id]);
    await this.insertItems(id, auth.org_id, dto.items);
    return this.get(id);
  }

  async submit(id: string) {
    const m = this.rc.manager;
    const req = await this.requireStatus(id, ['DRAFT']);
    await m.query(`UPDATE procurement_requests SET status='SUBMITTED', updated_at=now() WHERE id=$1`, [id]);

    // Materialize the approval chain from the matching value-banded policy (if any).
    const total = Number(req.estimated_total_minor);
    const policy = (
      await m.query(
        `SELECT steps FROM approval_policies
         WHERE min_amount_minor <= $1 AND (max_amount_minor IS NULL OR $1 < max_amount_minor)
         ORDER BY min_amount_minor DESC LIMIT 1`,
        [total],
      )
    )[0];
    const steps: Array<{ order: number; role: string }> = policy ? policy.steps : [];
    let stepNo = 1;
    for (const s of [...steps].sort((a, b) => a.order - b.order)) {
      await m.query(
        `INSERT INTO approval_steps(request_id, owner_org_id, step_no, approver_role) VALUES ($1,$2,$3,$4)`,
        [id, req.owner_org_id, stepNo++, s.role],
      );
    }
    await this.audit.record('REQUEST_SUBMITTED', 'procurement_request', id, { steps: steps.length });
    return this.get(id);
  }

  // Approval recomputes the total server-side from items (client totals are never
  // trusted) and resolves the procurement method from the buyer's value-band policy.
  async approve(id: string, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    await m.query(`SELECT id FROM procurement_requests WHERE id=$1 FOR UPDATE`, [id]);
    const req = await this.requireStatus(id, ['SUBMITTED']);

    // Multi-step chain: advance the current step; only the FINAL step triggers the
    // full approval (total recompute + method resolution) below.
    const pending = await m.query(
      `SELECT * FROM approval_steps WHERE request_id=$1 AND status='SUBMITTED' ORDER BY step_no`,
      [id],
    );
    if (pending.length) {
      const current = pending[0];
      if (auth.role !== current.approver_role && auth.role !== 'BUYER_ADMIN') {
        throw new BadRequestException(`This step requires role ${current.approver_role}`);
      }
      await m.query(
        `UPDATE approval_steps SET status='APPROVED', acted_by=$2, acted_at=now() WHERE id=$1`,
        [current.id, auth.sub],
      );
      await this.audit.record('APPROVAL_STEP_ACTED', 'approval_step', current.id, { step_no: current.step_no, decision: 'APPROVED' });
      if (pending.length > 1) return this.get(id); // more steps remain — stays SUBMITTED
    }

    const totalRows = await m.query(
      `SELECT COALESCE(SUM(est_total_minor),0)::bigint AS total FROM request_items WHERE request_id=$1`,
      [id],
    );
    const total = Number(totalRows[0].total);
    const method = await this.resolveMethod(req.category, total);
    await m.query(
      `UPDATE procurement_requests
       SET status='APPROVED', approved_by=$2, estimated_total_minor=$3, method_resolved=$4, updated_at=now()
       WHERE id=$1`,
      [id, auth.sub, total, method],
    );
    await this.audit.record('REQUEST_APPROVED', 'procurement_request', id, { total, method });
    return this.get(id);
  }

  async reject(id: string, auth: AccessTokenPayload, reason?: string) {
    const m = this.rc.manager;
    await this.requireStatus(id, ['SUBMITTED']);
    // Any approver in the chain can reject; mark their current step and the request.
    const pending = await m.query(
      `SELECT * FROM approval_steps WHERE request_id=$1 AND status='SUBMITTED' ORDER BY step_no`,
      [id],
    );
    if (pending.length) {
      const current = pending[0];
      if (auth.role !== current.approver_role && auth.role !== 'BUYER_ADMIN') {
        throw new BadRequestException(`This step requires role ${current.approver_role}`);
      }
      await m.query(`UPDATE approval_steps SET status='REJECTED', acted_by=$2, acted_at=now() WHERE id=$1`, [current.id, auth.sub]);
    }
    await m.query(
      `UPDATE procurement_requests SET status='REJECTED', rejected_by=$2, updated_at=now() WHERE id=$1`,
      [id, auth.sub],
    );
    await this.audit.record('REQUEST_REJECTED', 'procurement_request', id, { reason: reason ?? null });
    return this.get(id);
  }

  async getPolicies() {
    return this.rc.manager.query(
      `SELECT id, category, min_amount_minor, max_amount_minor, method
       FROM procurement_method_policies ORDER BY category, min_amount_minor`,
    );
  }

  async replacePolicies(
    orgId: string,
    policies: Array<{ category: string; minAmountMinor: number; maxAmountMinor: number | null; method: ProcurementMethod }>,
  ) {
    const m = this.rc.manager;
    await m.query(`DELETE FROM procurement_method_policies`);
    for (const p of policies) {
      await m.query(
        `INSERT INTO procurement_method_policies(buyer_org_id, category, min_amount_minor, max_amount_minor, method)
         VALUES ($1,$2,$3,$4,$5)`,
        [orgId, p.category ?? '*', p.minAmountMinor, p.maxAmountMinor, p.method],
      );
    }
    return this.getPolicies();
  }

  private async resolveMethod(category: string, total: number): Promise<ProcurementMethod> {
    const rows = await this.rc.manager.query(
      `SELECT method FROM procurement_method_policies
       WHERE (category = $1 OR category = '*')
         AND min_amount_minor <= $2 AND (max_amount_minor IS NULL OR $2 < max_amount_minor)
       ORDER BY (category = '*') ASC, min_amount_minor DESC LIMIT 1`,
      [category, total],
    );
    return rows.length ? rows[0].method : 'DIRECT';
  }

  private computeTotal(items: ItemDto[]): number {
    if (!items.length) throw new BadRequestException('At least one item is required');
    return items.reduce((sum, it) => sum + it.qty * it.estUnitPriceMinor, 0);
  }

  private async insertItems(requestId: string, orgId: string, items: ItemDto[]): Promise<void> {
    let line = 1;
    for (const it of items) {
      await this.rc.manager.query(
        `INSERT INTO request_items(owner_org_id, request_id, line_no, name, description, qty, uom,
           est_unit_price_minor, vat_rate_bp, est_total_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          orgId, requestId, line++, it.name, it.description ?? null, it.qty, it.uom ?? 'pcs',
          it.estUnitPriceMinor, it.vatRateBp ?? 1800, it.qty * it.estUnitPriceMinor,
        ],
      );
    }
  }

  private async requireStatus(id: string, allowed: string[]) {
    const rows = await this.rc.manager.query(`SELECT * FROM procurement_requests WHERE id=$1`, [id]);
    if (!rows.length) throw new NotFoundException('Request not found');
    if (!allowed.includes(rows[0].status)) {
      throw new BadRequestException(`Request is ${rows[0].status}; expected ${allowed.join('/')}`);
    }
    return rows[0];
  }
}

@Controller('requests')
export class RequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Get() @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  list(@Query('q') q?: string) { return this.requests.list(q); }

  @Get('method-policies') @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  policies() { return this.requests.getPolicies(); }

  @Put('method-policies') @Roles('BUYER_ADMIN')
  replacePolicies(@CurrentUser() auth: AccessTokenPayload, @Body() body: { policies: any[] }) {
    return this.requests.replacePolicies(auth.org_id, body.policies ?? []);
  }

  @Get('approval-policies') @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  approvalPolicies() { return this.requests.getApprovalPolicies(); }

  @Put('approval-policies') @Roles('BUYER_ADMIN')
  replaceApprovalPolicies(@CurrentUser() auth: AccessTokenPayload, @Body() body: { policies: any[] }) {
    return this.requests.replaceApprovalPolicies(auth.org_id, body.policies ?? []);
  }

  @Get(':id') @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  get(@Param('id') id: string) { return this.requests.get(id); }

  @Post() @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  create(@Body() dto: UpsertRequestDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.requests.create(dto, auth);
  }

  @Put(':id') @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  update(@Param('id') id: string, @Body() dto: UpsertRequestDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.requests.update(id, dto, auth);
  }

  @Post(':id/submit') @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  submit(@Param('id') id: string) { return this.requests.submit(id); }

  @Post(':id/approve') @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  approve(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload) {
    return this.requests.approve(id, auth);
  }

  @Post(':id/reject') @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  reject(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload, @Body() body: { reason?: string }) {
    return this.requests.reject(id, auth, body?.reason);
  }
}

@Module({ controllers: [RequestsController], providers: [RequestsService] })
export class RequestsModule {}
