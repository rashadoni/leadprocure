import { existsSync, readFileSync } from 'fs';
import { ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  EntitlementSnapshot,
  FEATURE_KEYS,
  FeatureKey,
  LicenseClaims,
  LicenseStatus,
} from '@leadprocure/shared';
import { AppConfig } from '../config/config.service';
import { RequestContextService } from '../context/request-context.service';
import { publicKeyFromB64Pem, verifyLicenseToken } from './paseto-license';

const RENEWAL_WINDOW_MS = 7 * 24 * 3600 * 1000;

@Injectable()
export class EntitlementService implements OnModuleInit {
  private readonly logger = new Logger(EntitlementService.name);
  private snap!: EntitlementSnapshot;
  private claims?: LicenseClaims;
  private revoked = false;
  private source: 'installed'|'file'|'development'|'missing' = 'missing';

  constructor(
    private readonly ds: DataSource,
    private readonly cfg: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    const rows = await this.ds.query(
      `SELECT * FROM licenses ORDER BY installed_at DESC LIMIT 1`,
    );
    if (rows.length) {
      try {
        this.claims = await this.verify(rows[0].raw_token);
        this.revoked = rows[0].status === 'revoked';
        this.source = 'installed';
        this.snap = this.fromClaims(this.claims, this.revoked);
      } catch {
        this.claims = undefined; this.source = 'missing'; this.snap = this.restricted();
      }
      this.logger.log(`License loaded: edition=${this.snap.edition} status=${this.snap.status}`);
      return;
    }
    if (this.cfg.licensePublicKeyB64 && this.cfg.licenseFile && existsSync(this.cfg.licenseFile)) {
      try {
        const token = readFileSync(this.cfg.licenseFile, 'utf8').trim();
        const claims = await this.verify(token);
        this.claims = claims; this.revoked = false; this.source = 'file';
        this.snap = this.fromClaims(claims, false);
        this.logger.log(`License file verified: edition=${claims.edition}`);
        return;
      } catch (e) {
        this.logger.error(`License file invalid: ${(e as Error).message}`);
      }
    }
    this.claims = undefined;
    this.source = this.cfg.nodeEnv === 'production' ? 'missing' : 'development';
    this.snap = this.source === 'missing' ? this.restricted() : this.devFallback();
    this.logger.warn(`License source=${this.source}, status=${this.snap.status}`);
  }

  async installFromToken(token: string): Promise<void> {
    const claims = await this.verify(token);
    const status = this.computeStatus(claims, false);
    await this.ds.query(
      `INSERT INTO licenses(license_id, customer_id, deployment_type, license_type, edition,
        features, limits, valid_from, expires_at, grace_until, status, raw_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        claims.license_id, claims.customer_id, claims.deployment_type, claims.license_type,
        claims.edition, claims.features, JSON.stringify(claims.limits), claims.valid_from,
        claims.expires_at, claims.grace_until, status, token,
      ],
    );
    await this.reload();
  }

  snapshot(): EntitlementSnapshot {
    if (this.claims) this.snap = this.fromClaims(this.claims, this.revoked);
    return { ...this.snap, source: this.source };
  }
  hasFeature(f: FeatureKey): boolean {
    return this.snapshot().features.includes(f);
  }
  status(): LicenseStatus {
    return this.snapshot().status;
  }
  // Graceful degradation: creating NEW work is blocked once restricted/revoked,
  // but completing already-live procurement stays allowed (enforced in services).
  canCreateNew(): boolean {
    return !['expired_restricted','revoked'].includes(this.status());
  }
  assertCanCreateNew(): void {
    if (!this.canCreateNew()) {
      throw new ForbiddenException(`License ${this.snap.status}: cannot create new items — renew to continue`);
    }
  }

  private async verify(token: string): Promise<LicenseClaims> {
    if (!this.cfg.licensePublicKeyB64) throw new Error('LICENSE_PUBLIC_KEY_B64 not configured');
    const c = await verifyLicenseToken(token, publicKeyFromB64Pem(this.cfg.licensePublicKeyB64));
    if (![c.valid_from,c.expires_at,c.grace_until].every(x=>Number.isFinite(Date.parse(x))) ||
        Date.parse(c.valid_from)>Date.parse(c.expires_at) || Date.parse(c.expires_at)>Date.parse(c.grace_until) ||
        !Array.isArray(c.features) || c.features.some(f=>!FEATURE_KEYS.includes(f)) || !c.limits || c.schema_version!==1)
      throw new Error('Invalid license claims');
    return c;
  }

  private computeStatus(claims: LicenseClaims, revoked: boolean): LicenseStatus {
    if (revoked) return 'revoked';
    const now = Date.now();
    if (now < Date.parse(claims.valid_from)) return 'expired_restricted';
    const expires = Date.parse(claims.expires_at);
    const grace = Date.parse(claims.grace_until);
    if (now > grace) return 'expired_restricted';
    if (now > expires) return 'grace';
    if (now > expires - RENEWAL_WINDOW_MS) return 'renewal_due';
    return 'valid';
  }

  private fromClaims(c: LicenseClaims, revoked: boolean): EntitlementSnapshot {
    return {
      status: this.computeStatus(c, revoked),
      edition: c.edition,
      deploymentMode: c.deployment_type,
      features: c.features,
      limits: c.limits,
      expiresAt: c.expires_at,
      graceUntil: c.grace_until,
    };
  }

  private fromRow(row: any): EntitlementSnapshot {
    const claims: LicenseClaims = {
      license_id: row.license_id,
      customer_id: row.customer_id,
      deployment_type: row.deployment_type,
      license_type: row.license_type,
      edition: row.edition,
      features: row.features,
      limits: typeof row.limits === 'string' ? JSON.parse(row.limits) : row.limits,
      valid_from: new Date(row.valid_from).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
      grace_until: new Date(row.grace_until).toISOString(),
      key_id: '',
      schema_version: 1,
    };
    return this.fromClaims(claims, row.status === 'revoked');
  }

  private restricted(): EntitlementSnapshot {
    return {...this.devFallback(),status:'expired_restricted',expiresAt:new Date(0).toISOString(),graceUntil:new Date(0).toISOString()};
  }

  private devFallback(): EntitlementSnapshot {
    const farFuture = new Date(Date.now() + 3650 * 24 * 3600 * 1000).toISOString();
    return {
      status: 'valid',
      edition: this.cfg.licenseDevEdition,
      deploymentMode: this.cfg.deploymentMode,
      features: [...FEATURE_KEYS],
      limits: { max_buyer_orgs: null, seats: null, events_month: null },
      expiresAt: farFuture,
      graceUntil: farFuture,
    };
  }
}

@Injectable()
export class QuotaService {
  constructor(
    private readonly rc: RequestContextService,
    private readonly entitlements: EntitlementService,
  ) {}

  // Atomic monthly-event quota using entitlement_usage(org_id, metric, period).
  async consumeMonthlyEvent(orgId: string): Promise<void> {
    const limit = this.entitlements.snapshot().limits.events_month;
    if (limit == null) return; // unlimited
    const period = new Date().toISOString().slice(0, 7); // YYYY-MM
    const rows = await this.rc.manager.query(
      `INSERT INTO entitlement_usage(org_id, metric, period, count) VALUES ($1,'events_month',$2,1)
       ON CONFLICT (org_id, metric, period)
       DO UPDATE SET count = entitlement_usage.count + 1, updated_at = now()
       RETURNING count`,
      [orgId, period],
    );
    if (rows[0].count > limit) {
      throw new ForbiddenException('License limit reached: monthly sourcing events');
    }
  }
}
