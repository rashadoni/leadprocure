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
import { IsEmail, IsIn, IsString, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { RequestContextService } from '../../common/context/request-context.service';
import { AuditService } from '../../common/audit/audit.service';

@Injectable()
export class SettingsService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  async users(orgId: string) {
    return this.rc.manager.query(
      `SELECT u.id, u.email, u.full_name, u.status, m.role, m.created_at
       FROM memberships m JOIN organization_users u ON u.id = m.user_id
       WHERE m.org_id = $1 ORDER BY m.created_at`,
      [orgId],
    );
  }

  // Role changes: admin-only, never your own role (anti-escalation), always audited.
  async setRole(userId: string, role: MembershipRole, auth: AccessTokenPayload) {
    if (userId === auth.sub) throw new ForbiddenException('You cannot change your own role');
    if (!MEMBERSHIP_ROLES.includes(role)) throw new BadRequestException('Unknown role');
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
    await m.query(
      `INSERT INTO memberships(user_id, org_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, org_id, role) DO NOTHING`,
      [userId, auth.org_id, dto.role],
    );
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

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('users')
  @Roles('BUYER_ADMIN', 'BUYER_APPROVER', 'BUYER_USER')
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
}

@Module({ controllers: [SettingsController], providers: [SettingsService] })
export class SettingsModule {}
