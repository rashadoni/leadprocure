import { returnedRows } from '../../common/procurement/invariants';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import type { AccessTokenPayload, MembershipRole } from '@leadprocure/shared';
import { MEMBERSHIP_ROLES } from '@leadprocure/shared';
import { IsEmail, IsIn, IsOptional, IsString, IsUUID, MinLength, ValidateIf } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';

@Injectable()
export class SettingsService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  // A role belongs to a kind of organization: a buyer org has no SUPPLIER_USER and a
  // supplier org has no buyer roles. Only the web UI's own list enforced that — the API
  // took any member of the shared enum, so a buyer admin could set SUPPLIER_USER inside a
  // BUYER org. That member then loses every buyer page and is admitted to the
  // supplier-only routes with a buyer organization behind them.
  private assertRoleFitsOrg(role: MembershipRole, auth: AccessTokenPayload) {
    if (auth.org_kind === 'BOTH') return; // trades on both sides: either role is real
    const fits = auth.org_kind === 'SUPPLIER' ? role === 'SUPPLIER_USER' : role.startsWith('BUYER_');
    if (!fits) {
      throw new BadRequestException(`Role ${role} does not belong to a ${auth.org_kind} organization`);
    }
  }

  async users(orgId: string) {
    return this.rc.manager.query(
      `SELECT u.id, u.email, u.full_name, u.status, m.role, m.created_at, m.department_id,
              (SELECT d.code FROM departments d WHERE d.id = m.department_id) AS department_code
       FROM memberships m JOIN organization_users u ON u.id = m.user_id
       WHERE m.org_id = $1 ORDER BY m.created_at`,
      [orgId],
    );
  }

  // Home department: the default for the user's requests and the budget scope a plain
  // BUYER_USER may see. Admin-only, and the department must belong to this org (RLS).
  async setDepartment(userId: string, departmentId: string | null, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    if (departmentId) {
      const dep = await m.query(`SELECT id FROM departments WHERE id = $1`, [departmentId]);
      if (!dep.length) throw new BadRequestException('Unknown department');
    }
    const rows = returnedRows(await m.query(
      `UPDATE memberships SET department_id = $3 WHERE user_id = $1 AND org_id = $2 RETURNING id`,
      [userId, auth.org_id, departmentId],
    ));
    if (!rows.length) throw new BadRequestException('User is not a member of your organization');
    await this.audit.record('MEMBER_DEPARTMENT_SET', 'membership', rows[0].id, {
      user_id: userId, department_id: departmentId,
    });
    return this.users(auth.org_id);
  }

  // Role changes: admin-only, never your own role (anti-escalation), always audited.
  async setRole(userId: string, role: MembershipRole, auth: AccessTokenPayload) {
    if (userId === auth.sub) throw new ForbiddenException('You cannot change your own role');
    if (!MEMBERSHIP_ROLES.includes(role)) throw new BadRequestException('Unknown role');
    this.assertRoleFitsOrg(role, auth);
    const rows = returnedRows(await this.rc.manager.query(
      `UPDATE memberships SET role = $3 WHERE user_id = $1 AND org_id = $2 RETURNING id`,
      [userId, auth.org_id, role],
    ));
    if (!rows.length) throw new BadRequestException('User is not a member of your organization');
    // Bump token_version so the target's old access/refresh tokens die.
    await this.rc.manager.query(
      `UPDATE organization_users SET token_version = token_version + 1 WHERE id = $1`,
      [userId],
    );
    await this.audit.record('ROLE_CHANGED', 'membership', rows[0].id, { user_id: userId, role });
    return { ok: true };
  }

  async addUser(dto: { email: string; fullName: string; password: string; role: MembershipRole }, auth: AccessTokenPayload) {
    const m = this.rc.manager;
    this.assertRoleFitsOrg(dto.role, auth);
    const argon2 = await import('argon2');
    const existing = await m.query(`SELECT id FROM organization_users WHERE email = $1`, [dto.email]);
    let userId: string;
    if (existing.length) {
      userId = existing[0].id;
    } else {
      const hash = await argon2.hash(dto.password, { type: argon2.argon2id });
      userId = (
        await m.query(
          `INSERT INTO organization_users(email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id`,
          [dto.email, hash, dto.fullName],
        )
      )[0].id;
    }
    // One membership per pair. Adding the same person again with a different role used to
    // insert a second row — legal under the old three-column key — and from then on every
    // role change for them collided with it. Send the admin to the role control, which
    // audits the change and kills the target's tokens; this path does neither.
    const already = await m.query(
      `SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2`,
      [userId, auth.org_id],
    );
    if (already.length) {
      throw new BadRequestException(
        `${dto.email} is already a member of your organization as ${already[0].role} — change the role instead`,
      );
    }
    const membership = (
      await m.query(
        `INSERT INTO memberships(user_id, org_id, role) VALUES ($1,$2,$3) RETURNING id`,
        [userId, auth.org_id, dto.role],
      )
    )[0];
    // Granting someone access to the organization was the one membership change that left
    // no trace, while changing their role and their department both did.
    await this.audit.record('MEMBER_ADDED', 'membership', membership.id, {
      user_id: userId, email: dto.email, role: dto.role,
      // organization_users is global and carries no RLS, so an address that already has an
      // account anywhere is attached rather than created. Worth seeing in the trail.
      existing_account: Boolean(existing.length),
    });
    return this.users(auth.org_id);
  }
}

class AddUserDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(2) fullName!: string;
  @IsString() @MinLength(8) password!: string;
  @IsIn(MEMBERSHIP_ROLES) role!: MembershipRole;
}
class SetRoleDto {
  @IsIn(MEMBERSHIP_ROLES) role!: MembershipRole;
}
class SetDepartmentDto {
  // null / '' clears the home department.
  @IsOptional() @ValidateIf((_o, v) => v !== null && v !== '') @IsUUID() departmentId?: string | null;
}

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('users')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER', 'BUYER_FINANCE')
  users(@CurrentUser() auth: AccessTokenPayload) {
    return this.settings.users(auth.org_id);
  }

  @Post('users')
  @Roles('BUYER_ADMIN')
  addUser(@Body() body: AddUserDto, @CurrentUser() auth: AccessTokenPayload) {
    return this.settings.addUser(body, auth);
  }

  @Post('users/:userId/role')
  @Roles('BUYER_ADMIN')
  setRole(
    @Param('userId') userId: string,
    @Body() body: SetRoleDto,
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.settings.setRole(userId, body.role, auth);
  }

  @Post('users/:userId/department')
  @Roles('BUYER_ADMIN')
  setDepartment(
    @Param('userId') userId: string,
    @Body() body: SetDepartmentDto,
    @CurrentUser() auth: AccessTokenPayload,
  ) {
    return this.settings.setDepartment(userId, body.departmentId || null, auth);
  }
}

@Module({ controllers: [SettingsController], providers: [SettingsService] })
export class SettingsModule {}
