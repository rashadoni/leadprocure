import { returnedRows } from '../../common/procurement/invariants';
import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Injectable, Module,
  NotFoundException, Param, Post, Put,
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
              -- Only if that person is actually in THIS organisation. organization_users is
              -- global and carries no RLS at all, so an owner id pointing outside the buyer
              -- org — a row written before the check below existed, or straight in SQL —
              -- used to answer with a stranger's name and state. The membership condition is
              -- the read side of the same promise: deactivation keeps the membership, so a
              -- switched-off owner still reads normally; only somebody who is not here at
              -- all goes unnamed.
              (SELECT u.full_name FROM organization_users u
                WHERE u.id = d.owner_user_id
                  AND EXISTS (SELECT 1 FROM memberships m
                                WHERE m.user_id = u.id AND m.org_id = d.buyer_org_id)) AS owner_name,
              -- The owner's own state travels with the name, because a filled-in owner alone
              -- cannot say whether the budget warning addressed to them still reaches that
              -- person. It no longer goes nowhere — NotifyService widens it to the whole
              -- organisation and records that it did — but «the one person answerable for
              -- this budget» and «everybody» are different things, and the screen is where
              -- that difference is noticed in time to name somebody new.
              (SELECT u.status FROM organization_users u
                WHERE u.id = d.owner_user_id
                  AND EXISTS (SELECT 1 FROM memberships m
                                WHERE m.user_id = u.id AND m.org_id = d.buyer_org_id)) AS owner_status,
              (SELECT count(*)::int FROM procurement_requests pr WHERE pr.department_id = d.id) AS usage_count
       FROM departments d
       ORDER BY d.code`,
    );
  }

  // The owner is who a budget warning is ADDRESSED to — `departments.owner_user_id` reaches
  // `notify.notifyUser` in modules/budgets — so the column has to hold somebody who can act
  // on it: a member of THIS organisation, not switched off. Nothing checked it. The picker
  // on screen stopped offering anybody else, but a picker is not a check: the id arrives in
  // the request body, and `PUT` took any well-formed uuid, including a stranger's.
  //
  // `current` is admitted whatever their state, deliberately. People are deactivated long
  // after they were named; the row then legitimately goes on pointing at them (the screen
  // marks it «deaktiv», and NotifyService widens the warning to the organisation and records
  // that it did). `PUT /departments/:id` replaces the WHOLE row, so every unrelated edit
  // resends the owner as it stands — refusing it would make renaming or retiring such a
  // department impossible until somebody also picked a new owner, which is how a rule gets
  // worked around instead of obeyed. Clearing the owner stays free.
  private async assertOwnerCanBeNamed(
    ownerUserId: string | null,
    current: string | null,
    orgId: string,
  ): Promise<void> {
    if (!ownerUserId || ownerUserId === current) return;
    const rows = await this.rc.manager.query(
      `SELECT u.status, u.full_name FROM memberships m JOIN organization_users u ON u.id = m.user_id
        WHERE m.org_id = $1 AND m.user_id = $2`,
      [orgId, ownerUserId],
    );
    // Nothing about the stranger is echoed back: outside this organisation, their very
    // existence is not this caller's business.
    if (!rows.length) throw new BadRequestException('The owner must be a member of your organization');
    if (rows[0].status !== 'ACTIVE') {
      throw new BadRequestException(
        `${rows[0].full_name} is deactivated and cannot be made owner of a department — a budget warning addressed to them would reach the whole organization instead`,
      );
    }
  }

  async create(dto: UpsertDepartmentDto, auth: AccessTokenPayload) {
    const code = dto.code.trim();
    await this.assertOwnerCanBeNamed(dto.ownerUserId ?? null, null, auth.org_id);
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

  async update(id: string, dto: UpsertDepartmentDto, auth: AccessTokenPayload) {
    const code = dto.code.trim();
    // A department cannot be its own parent — the tree walk in reporting would never end.
    if (dto.parentId && dto.parentId === id) {
      throw new ConflictException('A department cannot be its own parent');
    }
    // The owner it already has decides whether the submitted one is a change at all. RLS
    // scopes this read, so another organisation's department is simply not found.
    const existing = (
      await this.rc.manager.query(`SELECT owner_user_id FROM departments WHERE id = $1`, [id])
    )[0] as { owner_user_id: string | null } | undefined;
    if (!existing) throw new NotFoundException('Department not found');
    await this.assertOwnerCanBeNamed(dto.ownerUserId ?? null, existing.owner_user_id, auth.org_id);
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
  update(
    @Param('id') id: string,
    @Body() dto: UpsertDepartmentDto,
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.departments.update(id, dto, auth);
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
