import { createHash, randomUUID } from 'crypto';
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import type { AccessTokenPayload, MembershipRole, OrganizationKind } from '@leadprocure/shared';
import { RequestContextService } from '../../common/context/request-context.service';
import { TokenService } from '../../common/auth/token.service';
import { AppConfig } from '../../common/config/config.service';
import { AuditService } from '../../common/audit/audit.service';
import { RegisterOrgDto, LoginDto } from './dto';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  status: string;
  token_version: number;
}
interface MembershipRow {
  org_id: string;
  role: MembershipRole;
  kind: OrganizationKind;
  legal_name: string;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; fullName: string };
  org: { id: string; role: MembershipRole; kind: OrganizationKind; name: string };
}

@Injectable()
export class IdentityService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly tokens: TokenService,
    private readonly cfg: AppConfig,
    private readonly audit: AuditService,
  ) {}

  async register(dto: RegisterOrgDto, kind: OrganizationKind, role: MembershipRole): Promise<AuthResult> {
    const m = this.rc.manager;
    const existing = await m.query(`SELECT id FROM organization_users WHERE email = $1`, [dto.email]);
    if (existing.length) throw new ConflictException('Email already registered');

    const originByMode = this.cfg.deploymentMode === 'on_prem_isolated' ? 'ON_PREM_LOCAL' : 'SAAS';
    const org = (
      await m.query(
        `INSERT INTO organizations(kind, identity_origin, legal_name, voen) VALUES ($1,$2,$3,$4) RETURNING id`,
        [kind, originByMode, dto.legalName, dto.voen ?? null],
      )
    )[0];
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    const user = (
      await m.query(
        `INSERT INTO organization_users(email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id`,
        [dto.email, passwordHash, dto.fullName],
      )
    )[0];
    await m.query(`INSERT INTO memberships(user_id, org_id, role) VALUES ($1,$2,$3)`, [
      user.id,
      org.id,
      role,
    ]);

    // Elevate RLS context to the new org so owner-scoped inserts pass WITH CHECK.
    await this.rc.setOrg(org.id, role);
    if (kind === 'BUYER') {
      await m.query(`INSERT INTO buyer_profiles(org_id) VALUES ($1)`, [org.id]);
    } else {
      await m.query(`INSERT INTO supplier_profiles(org_id) VALUES ($1)`, [org.id]);
    }
    await this.audit.record('ORG_REGISTERED', 'organization', org.id, { kind, email: dto.email });

    return this.issue(
      { id: user.id, email: dto.email, full_name: dto.fullName, status: 'ACTIVE', password_hash: passwordHash, token_version: 0 },
      { org_id: org.id, role, kind, legal_name: dto.legalName },
    );
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const m = this.rc.manager;
    const users: UserRow[] = await m.query(`SELECT * FROM organization_users WHERE email = $1`, [
      dto.email,
    ]);
    const user = users[0];
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Invalid credentials');
    const ok = await argon2.verify(user.password_hash, dto.password);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    const memberships: MembershipRow[] = await m.query(
      `SELECT mem.org_id, mem.role, o.kind, o.legal_name
       FROM memberships mem JOIN organizations o ON o.id = mem.org_id
       WHERE mem.user_id = $1 ORDER BY mem.created_at`,
      [user.id],
    );
    if (memberships.length === 0) throw new UnauthorizedException('No organization membership');
    const membership =
      (dto.orgId && memberships.find((x) => x.org_id === dto.orgId)) || memberships[0];

    await this.audit.record('USER_LOGGED_IN', 'user', user.id, { org_id: membership.org_id });
    return this.issue(user, membership);
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string }> {
    let payload;
    try {
      payload = this.tokens.verifyRefresh(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const m = this.rc.manager;
    const rows = await m.query(
      `SELECT s.id, u.token_version, u.status FROM sessions s
       JOIN organization_users u ON u.id = s.user_id
       WHERE s.user_id = $1 AND s.org_id = $2 AND s.revoked = false
         AND s.refresh_hash = $3 AND s.expires_at > now()`,
      [payload.sub, payload.org_id, this.hashToken(refreshToken)],
    );
    if (!rows.length || rows[0].token_version !== payload.token_version || rows[0].status !== 'ACTIVE') {
      throw new UnauthorizedException('Session expired');
    }
    const membership: MembershipRow[] = await m.query(
      `SELECT mem.org_id, mem.role, o.kind, o.legal_name FROM memberships mem
       JOIN organizations o ON o.id = mem.org_id WHERE mem.user_id = $1 AND mem.org_id = $2`,
      [payload.sub, payload.org_id],
    );
    if (!membership.length) throw new UnauthorizedException('Membership revoked');
    const access = this.tokens.signAccess({
      sub: payload.sub,
      org_id: membership[0].org_id,
      org_kind: membership[0].kind,
      role: membership[0].role,
      token_version: payload.token_version,
    });
    return { accessToken: access };
  }

  async me(auth: AccessTokenPayload) {
    const m = this.rc.manager;
    const user = (
      await m.query(`SELECT id, email, full_name FROM organization_users WHERE id = $1`, [auth.sub])
    )[0];
    const memberships = await m.query(
      `SELECT mem.org_id, mem.role, o.kind, o.legal_name FROM memberships mem
       JOIN organizations o ON o.id = mem.org_id WHERE mem.user_id = $1`,
      [auth.sub],
    );
    return {
      user: { id: user.id, email: user.email, fullName: user.full_name },
      activeOrg: { id: auth.org_id, role: auth.role, kind: auth.org_kind },
      memberships,
    };
  }

  private async issue(user: UserRow, membership: MembershipRow): Promise<AuthResult> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      org_id: membership.org_id,
      org_kind: membership.kind,
      role: membership.role,
      token_version: user.token_version,
    };
    const accessToken = this.tokens.signAccess(payload);
    const refreshToken = this.tokens.signRefresh({
      sub: user.id,
      org_id: membership.org_id,
      token_version: user.token_version,
    });
    const expires = new Date(Date.now() + this.cfg.jwtRefreshTtl * 1000);
    await this.rc.manager.query(
      `INSERT INTO sessions(id, user_id, org_id, refresh_hash, expires_at) VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), user.id, membership.org_id, this.hashToken(refreshToken), expires],
    );
    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, fullName: user.full_name },
      org: { id: membership.org_id, role: membership.role, kind: membership.kind, name: membership.legal_name },
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
