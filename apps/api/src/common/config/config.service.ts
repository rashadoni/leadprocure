import { Injectable } from '@nestjs/common';
import type { DeploymentMode, Edition } from '@leadprocure/shared';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
function opt(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}
function int(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? parseInt(v, 10) : fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  return v == null ? fallback : v === 'true' || v === '1';
}

// Central typed configuration. process.env is populated by loadRootEnv() in main.ts / seed.ts.
@Injectable()
export class AppConfig {
  readonly nodeEnv = opt('NODE_ENV', 'development');
  readonly apiPort = int('API_PORT', 3000);
  readonly deploymentMode = opt('DEPLOYMENT_MODE', 'cloud_multi_tenant') as DeploymentMode;

  readonly databaseUrl = req('DATABASE_URL');

  readonly jwtAccessSecret = opt('JWT_ACCESS_SECRET', 'dev_access_secret_change_me');
  readonly jwtAccessTtl = int('JWT_ACCESS_TTL', 900);
  readonly jwtRefreshSecret = opt('JWT_REFRESH_SECRET', 'dev_refresh_secret_change_me');
  readonly jwtRefreshTtl = int('JWT_REFRESH_TTL', 1209600);
  readonly refreshCookieName = opt('REFRESH_COOKIE_NAME', 'lp_refresh');
  readonly refreshCookieSecure = bool('REFRESH_COOKIE_SECURE', false);
  // Rotating-refresh reuse leeway: a just-rotated token replayed within this window is
  // treated as a benign race (SPA reload / StrictMode double-mount / concurrent 401s),
  // not theft. Only reuse older than this trips the "revoke the family" breach response.
  readonly refreshReuseLeewayMs = int('JWT_REFRESH_REUSE_LEEWAY_MS', 15000);

  readonly bidMasterKeyB64 = opt('BID_MASTER_KEY_B64', '');

  readonly licensePublicKeyB64 = opt('LICENSE_PUBLIC_KEY_B64', '');
  readonly licenseFile = opt('LICENSE_FILE', '');
  readonly licenseDevEdition = opt('LICENSE_DEV_EDITION', 'enterprise') as Edition;

  readonly clamavEnabled = bool('CLAMAV_ENABLED', false);
  readonly clamavHost = opt('CLAMAV_HOST', 'localhost');
  readonly clamavPort = int('CLAMAV_PORT', 3310);

  // Comma-separated allowed browser origins for CORS (credentials mode requires
  // an explicit origin, never a wildcard).
  readonly webOrigins = opt('WEB_ORIGIN', 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // First allowed origin is where password-reset / invite links point.
  readonly webBaseUrl = this.webOrigins[0] ?? 'http://localhost:5173';

  readonly smtpHost = opt('SMTP_HOST', '');
  readonly smtpPort = int('SMTP_PORT', 587);
  readonly smtpUser = opt('SMTP_USER', '');
  readonly smtpPass = opt('SMTP_PASS', '');
  readonly mailFrom = opt('MAIL_FROM', 'Leadprocure <no-reply@leadprocure.local>');
}
