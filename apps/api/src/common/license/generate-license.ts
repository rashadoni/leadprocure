import 'reflect-metadata';
/**
 * License issuer CLI (vendor side). Generates the Ed25519 keypair once, then signs
 * PASETO v4.public license files the app verifies OFFLINE with the embedded public key.
 *
 *   pnpm --filter api license:gen keys
 *     → prints LICENSE_PUBLIC_KEY_B64 (embed in the app env) and license-private.pem
 *       (KEEP SECRET — vendor side only; git-ignored)
 *
 *   pnpm --filter api license:gen issue --customer "Acme MMC" --type server \
 *     --edition enterprise --months 12 [--deployment on_prem_isolated] \
 *     [--seats 50] [--events 100] [--orgs 1] [--out acme.license]
 *     → writes the signed license file the client uploads via POST /admin/license
 */
import { generateKeyPairSync, createPrivateKey } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { FEATURE_KEYS, LicenseClaims } from '@leadprocure/shared';
import { signLicenseToken } from './paseto-license';

const PRIVATE_KEY_FILE = 'license-private.pem';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];

  if (cmd === 'keys') {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    writeFileSync(PRIVATE_KEY_FILE, privPem, { mode: 0o600 });
    console.log(`Private key → ./${PRIVATE_KEY_FILE}  (vendor-side secret, git-ignored)`);
    console.log(`\nEmbed in the app environment:\nLICENSE_PUBLIC_KEY_B64=${Buffer.from(pubPem).toString('base64')}`);
    return;
  }

  if (cmd === 'issue') {
    if (!existsSync(PRIVATE_KEY_FILE)) {
      console.error(`No ${PRIVATE_KEY_FILE}. Run "license:gen keys" first.`);
      process.exit(1);
    }
    const months = parseInt(arg('months', '12')!, 10);
    const now = new Date();
    const expires = new Date(now);
    expires.setMonth(expires.getMonth() + months);
    const grace = new Date(expires);
    grace.setDate(grace.getDate() + 14); // 14-day grace after expiry

    const claims: LicenseClaims = {
      license_id: `lic_${Date.now().toString(36)}`,
      customer_id: arg('customer', 'unknown')!,
      deployment_type: (arg('deployment', 'on_prem_isolated') as LicenseClaims['deployment_type']),
      license_type: (arg('type', 'server') as LicenseClaims['license_type']),
      edition: (arg('edition', 'enterprise') as LicenseClaims['edition']),
      features: [...FEATURE_KEYS],
      limits: {
        max_buyer_orgs: arg('orgs') ? parseInt(arg('orgs')!, 10) : null,
        seats: arg('seats') ? parseInt(arg('seats')!, 10) : null,
        events_month: arg('events') ? parseInt(arg('events')!, 10) : null,
      },
      valid_from: now.toISOString(),
      expires_at: expires.toISOString(),
      grace_until: grace.toISOString(),
      key_id: 'k1',
      schema_version: 1,
    };
    const privateKey = createPrivateKey(readFileSync(PRIVATE_KEY_FILE));
    const token = await signLicenseToken(claims, privateKey);
    const out = arg('out', `${claims.customer_id.replace(/\W+/g, '-').toLowerCase()}.license`)!;
    writeFileSync(out, token);
    console.log(`License → ${out}`);
    console.log(JSON.stringify({ ...claims, features: `${claims.features.length} features` }, null, 2));
    return;
  }

  console.log('Usage: license:gen keys | license:gen issue --customer <name> [--type server|client] [--months 12] …');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
