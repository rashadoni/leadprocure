import { returnedRows } from '../../common/procurement/invariants';
import {
  Body, ConflictException, Controller, Delete, Get, Injectable, Module, NotFoundException, Param, Post, Put,
} from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import type { AccessTokenPayload } from '@leadprocure/shared';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';

class UpsertDepartmentDto {
  // A short, stable code (letters/digits/-/_) — this is what requests and budgets point at.
  // \w is ASCII-only, so "MƏRKƏZ" and "TƏCHİZAT" were rejected — unusable codes in the one
  // language this product ships in. Unicode letters and digits are allowed; spaces and
  // punctuation still are not, because the code is a short stable key, not a title.
  @IsString()
  @Matches(/^[\p{L}\p{N}_-]{1,40}$/u, { message: 'code: 1–40 chars, letters/digits/-/_' })
  code!: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsUUID() parentId?: string | null;
  @IsOptional() @IsUUID() ownerUserId?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

// Curated per-buyer departments (cost centres): the "who spends" dimension next to the
// category's "what is bought". All queries run under the buyer's RLS context.
@Injectable()
export class DepartmentsService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  // usage_count lets the UI grey out a delete that would 409 anyway.
  list() {
    return this.rc.manager.query(
      `SELECT d.id, d.code, d.name, d.parent_id, d.owner_user_id, d.is_active, d.created_at,
              (SELECT p.code FROM departments p WHERE p.id = d.parent_id) AS parent_code,
              (SELECT u.full_name FROM organization_users u WHERE u.id = d.owner_user_id) AS owner_name,
              (SELECT count(*)::int FROM procurement_requests pr WHERE pr.department_id = d.id) AS usage_count
       FROM departments d
       ORDER BY d.code`,
    );
  }

  async create(dto: UpsertDepartmentDto, auth: AccessTokenPayload) {
    const code = dto.code.trim();
    let id: string;
    try {
      id = (
        await this.rc.manager.query(
          `INSERT INTO departments(buyer_org_id, code, name, parent_id, owner_user_id, is_active)
           VALUES ($1,$2,$3,$4,$5,COALESCE($6, true)) RETURNING id`,
          [auth.org_id, code, dto.name?.trim() || null, dto.parentId ?? null, dto.ownerUserId ?? null, dto.isActive ?? null],
        )
      )[0].id;
    } catch (e: any) {
      if (e?.code === '23505') throw new ConflictException(`Department "${code}" already exists`);
      throw e;
    }
    await this.audit.record('DEPARTMENT_CREATED', 'department', id, { code });
    return this.getOne(id);
  }

  async update(id: string, dto: UpsertDepartmentDto) {
    const code = dto.code.trim();
    // A department cannot be its own parent — the tree walk in reporting would never end.
    if (dto.parentId && dto.parentId === id) {
      throw new ConflictException('A department cannot be its own parent');
    }
    let res: Array<{ id: string }>;
    try {
      res = returnedRows(await this.rc.manager.query(
        `UPDATE departments
         SET code=$2, name=$3, parent_id=$4, owner_user_id=$5, is_active=COALESCE($6, is_active), updated_at=now()
         WHERE id=$1 RETURNING id`,
        [id, code, dto.name?.trim() || null, dto.parentId ?? null, dto.ownerUserId ?? null, dto.isActive ?? null],
      ));
    } catch (e: any) {
      if (e?.code === '23505') throw new ConflictException(`Department "${code}" already exists`);
      throw e;
    }
    if (!res[0]) throw new NotFoundException('Department not found');
    await this.audit.record('DEPARTMENT_UPDATED', 'department', id, { code });
    return this.getOne(id);
  }

  // Deleting a department that already carries spend would silently orphan that history
  // (the FK is ON DELETE SET NULL so the DB would allow it), so refuse with a clean 409.
  // Deactivating is the supported way to retire a department.
  async remove(id: string) {
    const m = this.rc.manager;
    const dep = (await m.query(`SELECT code FROM departments WHERE id=$1`, [id]))[0];
    if (!dep) throw new NotFoundException('Department not found');
    const used = (
      await m.query(
        `SELECT (SELECT count(*)::int FROM procurement_requests WHERE department_id=$1) AS requests,
                (SELECT count(*)::int FROM departments WHERE parent_id=$1) AS children,
                (SELECT count(*)::int FROM memberships WHERE department_id=$1) AS members,
                (SELECT count(*)::int FROM budgets WHERE department_id=$1) AS budgets,
                (SELECT count(*)::int FROM purchase_orders WHERE department_id=$1) AS orders,
                (SELECT count(*)::int FROM invoices WHERE department_id=$1) AS invoices`,
        [id],
      )
    )[0];
    if (used.requests > 0 || used.children > 0 || used.members > 0 || used.budgets > 0 || used.orders > 0 || used.invoices > 0) {
      throw new ConflictException(
        `Department "${dep.code}" is in use (${used.requests} request(s), ${used.children} sub-department(s), ${used.members} member(s), ${used.budgets} budget(s), ${used.orders} order(s), ${used.invoices} invoice(s)) — deactivate it instead`,
      );
    }
    await m.query(`DELETE FROM departments WHERE id=$1`, [id]);
    await this.audit.record('DEPARTMENT_DELETED', 'department', id, { code: dep.code });
    return { ok: true };
  }

  private async getOne(id: string) {
    const found = (await this.list()).find((d: { id: string }) => d.id === id);
    if (!found) throw new NotFoundException('Department not found');
    return found;
  }
}

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER', 'BUYER_FINANCE')
  list() {
    return this.departments.list();
  }

  @Post()
  @Roles('BUYER_ADMIN')
  create(@Body() dto: UpsertDepartmentDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.departments.create(dto, auth);
  }

  @Put(':id')
  @Roles('BUYER_ADMIN')
  update(@Param('id') id: string, @Body() dto: UpsertDepartmentDto) {
    return this.departments.update(id, dto);
  }

  @Delete(':id')
  @Roles('BUYER_ADMIN')
  remove(@Param('id') id: string) {
    return this.departments.remove(id);
  }
}

@Module({
  controllers: [DepartmentsController],
  providers: [DepartmentsService],
  exports: [DepartmentsService],
})
export class DepartmentsModule {}
