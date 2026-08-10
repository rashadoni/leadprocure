import {
  BadRequestException,
  ForbiddenException,
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
import { IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { ProcurementMethod } from '@leadprocure/shared';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { pageFrom, parsePaging, Paging } from '../../common/http/paging';
import { BudgetsModule, BudgetsService } from '../budgets/budgets.module';
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
  // Which department's budget this spend belongs to. Omitted → the author's home
  // department (memberships.department_id); still NULL → reports as "unassigned".
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsIn(['INCLUSIVE', 'EXCLUSIVE']) vatMode?: 'INCLUSIVE' | 'EXCLUSIVE';
  @IsArray() @ValidateNested({ each: true }) @Type(() => ItemDto) items!: ItemDto[];
}
class RejectRequestDto {
  @IsOptional() @IsString() reason?: string;
}
// Cancelling releases budget, so the reason is mandatory — the audit trail must say why
// the money went back.
class CancelRequestDto {
  @IsString() @MinLength(3) reason!: string;
}
// Only meaningful when a block threshold is armed: the written justification for pushing
// an approval through it anyway.
class ApproveRequestDto {
  @IsOptional() @IsString() @MinLength(3) budgetOverrideReason?: string;
}
// Policy entries are buyer-configured maps; guard the envelope shape (array), leave the
// per-entry fields to the service which persists them as-is.
class ReplacePoliciesDto {
  @IsOptional() @IsArray() policies?: unknown[];
}

@Injectable()
export class RequestsService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
    private readonly budgets: BudgetsService,
  ) {}

  async list(q?: string, paging: Paging = parsePaging(), departmentId?: string) {
    const rows = await this.rc.manager.query(
      `SELECT pr.id, pr.request_no, pr.title, pr.status, pr.estimated_total_minor, pr.currency, pr.category,
              pr.method_resolved, pr.created_at, pr.department_id,
              (SELECT d.code FROM departments d WHERE d.id = pr.department_id) AS department_code,
              (SELECT u.full_name FROM organization_users u WHERE u.id = pr.created_by) AS created_by_name,
              count(*) OVER()::int AS total_count,
              (SELECT count(*)::int FROM approval_steps s WHERE s.request_id = pr.id) AS steps_total,
              (SELECT count(*)::int FROM approval_steps s WHERE s.request_id = pr.id AND s.status = 'APPROVED') AS steps_done,
              (SELECT s.approver_role FROM approval_steps s WHERE s.request_id = pr.id AND s.status = 'SUBMITTED'
               ORDER BY s.step_no LIMIT 1) AS current_role
       FROM procurement_requests pr
       WHERE ($1::text IS NULL OR pr.title ILIKE '%' || $1 || '%' OR pr.request_no ILIKE '%' || $1 || '%')
         AND ($4::uuid IS NULL OR pr.department_id = $4)
       ORDER BY pr.created_at DESC LIMIT $2 OFFSET $3`,
      [q ?? null, paging.limit, paging.offset, departmentId ?? null],
    );
    return pageFrom(rows, paging);
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
    const dep = rows[0].department_id
      ? (await m.query(`SELECT code, name FROM departments WHERE id = $1`, [rows[0].department_id]))[0]
      : null;
    return {
      ...rows[0],
      department_code: dep?.code ?? null,
      department_name: dep?.name ?? null,
      items,
      approvals,
    };
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
    const seq = await m.query(`SELECT next_document_no($1,'REQ') AS n`, [auth.org_id]);
    const requestNo = `REQ-${new Date().getFullYear()}-${String(Number(seq[0].n)).padStart(4, '0')}`;
    const total = this.computeTotal(dto.items);
    const departmentId = await this.resolveDepartment(dto.departmentId, auth);
    const req = (
      await m.query(
        `INSERT INTO procurement_requests(owner_org_id, request_no, title, category, department_id, vat_mode,
           estimated_total_minor, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [auth.org_id, requestNo, dto.title, dto.category ?? '*', departmentId, dto.vatMode ?? 'EXCLUSIVE', total, auth.sub],
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
       SET title=$2, category=$3, department_id=$4, vat_mode=$5, estimated_total_minor=$6,
           version=version+1, updated_at=now()
       WHERE id=$1`,
      [
        id, dto.title, dto.category ?? req.category,
        dto.departmentId ?? req.department_id,
        dto.vatMode ?? req.vat_mode, total,
      ],
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
  async approve(id: string, auth: AccessTokenPayload, budgetOverrideReason?: string) {
    const m = this.rc.manager;
    await m.query(`SELECT id FROM procurement_requests WHERE id=$1 FOR UPDATE`, [id]);
    const req = await this.requireStatus(id, ['SUBMITTED']);

    // Segregation of duties: the person who raised the request cannot approve it — the
    // spend always needs a second pair of eyes. (Checked before any approval-step mutation.)
    if (req.created_by && req.created_by === auth.sub) {
      throw new ForbiddenException('You cannot approve a request you created (segregation of duties)');
    }

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
      // Segregation of duties across the chain: no single person may clear two steps of the
      // same request (a BUYER_ADMIN can satisfy any step's role, so this is the real guard
      // that keeps a multi-step chain a genuine four-eyes control).
      const actedBefore = await m.query(
        `SELECT 1 FROM approval_steps WHERE request_id=$1 AND acted_by=$2 AND status='APPROVED' LIMIT 1`,
        [id, auth.sub],
      );
      if (actedBefore.length) {
        throw new ForbiddenException('Segregation of duties: a different approver must act each approval step');
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
    // approved_at is the date the spend is charged on — budgets slice by it, so it must be
    // the approval instant, not the (possibly much earlier) creation date.
    await m.query(
      `UPDATE procurement_requests
       SET status='APPROVED', approved_by=$2, approved_at=now(), estimated_total_minor=$3,
           method_resolved=$4, updated_at=now()
       WHERE id=$1`,
      [id, auth.sub, total, method],
    );
    await this.audit.record('REQUEST_APPROVED', 'procurement_request', id, { total, method });
    // Budget control. With no block threshold configured (the default) this only attaches
    // warnings, exactly as before. With one armed, it THROWS — and because the whole
    // request runs in one transaction, the approval above is rolled back with it.
    const budgetWarnings = await this.budgets.enforceOnApproval(id, auth, budgetOverrideReason);
    const approved = await this.get(id);
    return { ...approved, budgetWarnings };
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

  // Cancel an APPROVED request that will never be ordered. Without this the budget
  // commitment it holds is permanent: the money stays reserved against a purchase that
  // nobody is going to make. Refused once real orders exist — cancel those first, so the
  // spend history and the budget never disagree.
  async cancel(id: string, auth: AccessTokenPayload, reason: string) {
    const m = this.rc.manager;
    await this.requireStatus(id, ['APPROVED']);
    const live = await m.query(
      `SELECT po_no FROM purchase_orders WHERE request_id=$1 AND status NOT IN ('CANCELLED','REJECTED')`,
      [id],
    );
    if (live.length) {
      throw new BadRequestException(
        `Cannot cancel: order(s) ${live.map((p: any) => p.po_no).join(', ')} already exist — cancel them first`,
      );
    }
    await m.query(
      `UPDATE procurement_requests
       SET status='CANCELLED', cancelled_at=now(), cancel_reason=$2, updated_at=now()
       WHERE id=$1`,
      [id, reason],
    );
    await this.audit.record('REQUEST_CANCELLED', 'procurement_request', id, { reason, by: auth.sub });
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
    // Fail-safe: a spend that falls in a policy gap must go to the MOST competitive method
    // (open tender), never silently to a no-tender direct purchase.
    return rows.length ? rows[0].method : 'OPEN_TENDER';
  }

  // An explicit department must exist for THIS buyer (RLS makes another org's department
  // invisible, so a missing row is either a typo or a cross-org probe — both are 400).
  // With none given, fall back to the author's home department; NULL stays NULL.
  private async resolveDepartment(departmentId: string | undefined, auth: AccessTokenPayload): Promise<string | null> {
    const m = this.rc.manager;
    if (departmentId) {
      const found = await m.query(`SELECT id, is_active FROM departments WHERE id = $1`, [departmentId]);
      if (!found.length) throw new BadRequestException('Unknown department');
      if (!found[0].is_active) throw new BadRequestException('Department is inactive');
      return departmentId;
    }
    const home = await m.query(
      `SELECT department_id FROM memberships WHERE user_id = $1 AND org_id = $2 AND department_id IS NOT NULL LIMIT 1`,
      [auth.sub, auth.org_id],
    );
    return home[0]?.department_id ?? null;
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
  list(
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('departmentId') departmentId?: string,
  ) {
    return this.requests.list(q, parsePaging(page, pageSize), departmentId || undefined);
  }

  @Get('method-policies') @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  policies() { return this.requests.getPolicies(); }

  @Put('method-policies') @Roles('BUYER_ADMIN')
  replacePolicies(@CurrentUser() auth: AccessTokenPayload, @Body() body: ReplacePoliciesDto) {
    return this.requests.replacePolicies(auth.org_id, (body.policies as any[]) ?? []);
  }

  @Get('approval-policies') @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
  approvalPolicies() { return this.requests.getApprovalPolicies(); }

  @Put('approval-policies') @Roles('BUYER_ADMIN')
  replaceApprovalPolicies(@CurrentUser() auth: AccessTokenPayload, @Body() body: ReplacePoliciesDto) {
    return this.requests.replaceApprovalPolicies(auth.org_id, (body.policies as any[]) ?? []);
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
  approve(
    @Param('id') id: string,
    @CurrentUser() auth: AccessTokenPayload,
    @Body() body?: ApproveRequestDto,
  ) {
    return this.requests.approve(id, auth, body?.budgetOverrideReason);
  }

  @Post(':id/reject') @Roles('BUYER_ADMIN', 'BUYER_APPROVER')
  reject(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload, @Body() body: RejectRequestDto) {
    return this.requests.reject(id, auth, body?.reason);
  }

  @Post(':id/cancel') @Roles('BUYER_ADMIN')
  cancel(@Param('id') id: string, @CurrentUser() auth: AccessTokenPayload, @Body() body: CancelRequestDto) {
    return this.requests.cancel(id, auth, body.reason);
  }
}

@Module({ imports: [BudgetsModule], controllers: [RequestsController], providers: [RequestsService] })
export class RequestsModule {}
