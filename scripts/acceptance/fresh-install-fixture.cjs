// Executed only in the disposable CI API image. The ephemeral private key never
// leaves this process; stdout goes to a temporary fixture file, never CI logs.
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const { V4 } = require('/repo/apps/api/node_modules/paseto');
const { FEATURE_KEYS } = require('/repo/packages/shared/dist');
(async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const now = Date.now();
  const claims = {
    license_id: randomUUID(), customer_id: 'disposable-install-acceptance',
    deployment_type: 'on_prem_isolated', license_type: 'server', edition: 'enterprise',
    features: [...FEATURE_KEYS], limits: { max_buyer_orgs: null, seats: null, events_month: null },
    valid_from: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 30 * 86400_000).toISOString(),
    grace_until: new Date(now + 35 * 86400_000).toISOString(), key_id: 'ci-only', schema_version: 1,
  };
  process.stdout.write(JSON.stringify({
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64'),
    token: await V4.sign(claims, privateKey),
  }));
})().catch(e => { console.error(e.message); process.exit(1); });
