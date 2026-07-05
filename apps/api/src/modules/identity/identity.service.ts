import { createHash, randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { DataSource } from 'typeorm';
import type { AccessTokenPayload, MembershipRole, OrganizationKind } from '@leadprocure/shared';
import { randomBytes } from 'crypto';
import { RequestContextService } from '../../common/context/request-context.service';
import { TokenService } from '../../common/auth/token.service';
import { AppConfig } from '../../common/config/config.service';
import { AuditService } from '../../common/audit/audit.service';
import { MailProvider } from '../../common/mail/mail.module';
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
    private readonly mail: MailProvider,
    private readonly ds: DataSource,
  ) {}

  // Always returns ok (no account enumeration). Emails a one-time link when the
  // address exists. Runs with no org context — password_reset_tokens has no RLS.
  async forgotPassword(email: string): Promise<{ ok: true }> {
    const m = this.rc.manager;
    const users = await m.query(`SELECT id, full_name FROM organization_users WHERE email = $1`, [email]);
    if (users.length) {
      const raw = randomBytes(32).toString('base64url');
      const hash = this.hashToken(raw);
      const expires = new Date(Date.now() + 3600 * 1000); // 1h
      await m.query(
        `INSERT INTO password_reset_tokens(user_id, token_hash, expires_at) VALUES ($1,$2,$3)`,
        [users[0].id, hash, expires],
      );
      const link = `${this.cfg.webBaseUrl}/reset?token=${raw}`;
      await this.mail.send({
        to: email,
        subject: 'Leadprocure — password reset',
        html: `<p>Hello ${users[0].full_name},</p><p>Reset your password (valid 1 hour):</p><p><a href="${link}">${link}</a></p><p>If you didn't request this, ignore this email.</p>`,
      });
    }
    return { ok: true };
  }

  async resetPassword(token: string, newPassword: string): Promise<{ ok: true }> {
    if (!newPassword || newPassword.length < 8) throw new BadRequestException('Password too short');
    const m = this.rc.manager;
    const hash = this.hashToken(token);
    const rows = await m.query(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [hash],
    );
    if (!rows.length) throw new BadRequestException('Invalid or expired token');
    const pwHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    // Invalidate all existing sessions/access tokens by bumping token_version.
    await m.query(
      `UPDATE organization_users SET password_hash = $2, token_version = token_version + 1 WHERE id = $1`,
      [rows[0].user_id, pwHash],
    );
    await m.query(`UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`, [rows[0].id]);
    // Hard revoke (revoked_at NULL): a password reset kills every session outright — these
    // must never qualify for the rotation reuse-leeway.
    await m.query(`UPDATE sessions SET revoked = true, revoked_at = NULL WHERE user_id = $1`, [rows[0].user_id]);
    return { ok: true };
  }

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

  // Rotating refresh: each use revokes the presented token and issues a fresh one.
  // Re-presenting an already-rotated token is normally a theft signal → nuke the family.
  // But a legitimate client can race the same token twice (SPA reload, StrictMode
  // double-mount, several in-flight 401s all refreshing at once): the browser hasn't
  // received the new cookie yet, so both calls carry the old one. We tolerate that with
  // a short leeway window — a replay within `refreshReuseLeewayMs` of rotation gets fresh
  // creds without nuking; only stale reuse trips the breach response.
  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    let payload;
    try {
      payload = this.tokens.verifyRefresh(refreshToken);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const m = this.rc.manager;
    const hash = this.hashToken(refreshToken);
    const sessions = await m.query(
      `SELECT s.id, s.revoked, s.revoked_at, s.expires_at, u.token_version, u.status
       FROM sessions s JOIN organization_users u ON u.id = s.user_id
       WHERE s.user_id = $1 AND s.org_id = $2 AND s.refresh_hash = $3`,
      [payload.sub, payload.org_id, hash],
    );
    if (!sessions.length) throw new UnauthorizedException('Invalid refresh token');
    const s = sessions[0];
    const benignReplay =
      s.revoked &&
      s.revoked_at != null &&
      Date.now() - new Date(s.revoked_at).getTime() <= this.cfg.refreshReuseLeewayMs;
    if (s.revoked && !benignReplay) {
      // Stale reuse of a rotated token = theft signal. Hard revoke the WHOLE family
      // (revoked_at NULL) so nothing — not even recently-rotated tokens — stays
      // benign-replayable after a breach. This MUST run on a separate autocommit
      // connection: the request transaction rolls back when we throw below, which would
      // otherwise undo the revoke and make the breach response a no-op.
      await this.ds.query(`UPDATE sessions SET revoked = true, revoked_at = NULL WHERE user_id = $1`, [payload.sub]);
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    if (s.token_version !== payload.token_version || s.status !== 'ACTIVE' || new Date(s.expires_at).getTime() <= Date.now()) {
      throw new UnauthorizedException('Session expired');
    }
    const membership: MembershipRow[] = await m.query(
      `SELECT mem.org_id, mem.role, o.kind, o.legal_name FROM memberships mem
       JOIN organizations o ON o.id = mem.org_id WHERE mem.user_id = $1 AND mem.org_id = $2`,
      [payload.sub, payload.org_id],
    );
    if (!membership.length) throw new UnauthorizedException('Membership revoked');

    // Rotate out the presented token (skip if a benign replay already revoked it).
    if (!benignReplay) {
      await m.query(`UPDATE sessions SET revoked = true, revoked_at = now() WHERE id = $1`, [s.id]);
    }
    const access = this.tokens.signAccess({
      sub: payload.sub,
      org_id: membership[0].org_id,
      org_kind: membership[0].kind,
      role: membership[0].role,
      token_version: payload.token_version,
    });
    const newRefresh = this.tokens.signRefresh({
      sub: payload.sub,
      org_id: membership[0].org_id,
      token_version: payload.token_version,
    });
    const expires = new Date(Date.now() + this.cfg.jwtRefreshTtl * 1000);
    await m.query(
      `INSERT INTO sessions(id, user_id, org_id, refresh_hash, expires_at) VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), payload.sub, membership[0].org_id, this.hashToken(newRefresh), expires],
    );
    return { accessToken: access, refreshToken: newRefresh };
  }

  // Server-side logout: hard-revoke the presented refresh session so the token can't be
  // refreshed after sign-out (clearing the cookie alone leaves a stolen copy usable).
  // Tolerant of a missing/garbage token — logout must never error the client.
  async logout(refreshToken: string | undefined): Promise<{ ok: true }> {
    if (!refreshToken) return { ok: true };
    let payload;
    try {
      payload = this.tokens.verifyRefresh(refreshToken);
    } catch {
      return { ok: true };
    }
    await this.rc.manager.query(
      `UPDATE sessions SET revoked = true, revoked_at = NULL WHERE user_id = $1 AND refresh_hash = $2`,
      [payload.sub, this.hashToken(refreshToken)],
    );
    return { ok: true };
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
