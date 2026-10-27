// Modeled legacy-volume upgrade, using only synthetic data on a hosted worker.
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { S3Client, CreateBucketCommand, PutBucketVersioningCommand, PutObjectCommand,
  GetObjectCommand, ListObjectVersionsCommand } = require('../../apps/api/node_modules/@aws-sdk/client-s3');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const bucket = 'isolated-legacy-upgrade';
const client = new S3Client({ endpoint: 'http://127.0.0.1:39500', region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: 'legacy-fixture-access', secretAccessKey: 'legacy-fixture-secret-never-production' } });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
(async () => {
  let baseline;
  if (process.argv[2] === 'seed') {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }));
    const entries = [];
    for (const [key, content] of [['price-sheet.csv', 'item,price\ncable,100\n'],
      ['attachment.txt', 'synthetic procurement attachment'], ['terms.txt', 'version one'], ['terms.txt', 'version two']]) {
      const bytes = Buffer.from(content);
      const result = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes,
        ContentType: 'text/plain', Metadata: { acceptance: 'legacy-upgrade' } }));
      assert.ok(result.VersionId);
      entries.push({ key, versionId: result.VersionId, sha256: sha(bytes), size: bytes.length });
    }
    baseline = { entries };
    writeFileSync(process.env.STORAGE_UPGRADE_BASELINE, JSON.stringify(baseline, null, 2));
  } else {
    assert.equal(process.argv[2], 'verify');
    baseline = JSON.parse(readFileSync(process.env.STORAGE_UPGRADE_BASELINE, 'utf8'));
  }
  for (const entry of baseline.entries) {
    const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: entry.key, VersionId: entry.versionId }));
    const bytes = Buffer.from(await object.Body.transformToByteArray());
    assert.equal(sha(bytes), entry.sha256); assert.equal(bytes.length, entry.size);
    assert.equal(object.Metadata.acceptance, 'legacy-upgrade');
  }
  const versions = await client.send(new ListObjectVersionsCommand({ Bucket: bucket }));
  assert.equal(versions.Versions.length, 4);
  assert.equal(versions.Versions.filter(v => v.Key === 'terms.txt').length, 2);
  const current = await client.send(new GetObjectCommand({ Bucket: bucket, Key: 'terms.txt' }));
  assert.equal(await current.Body.transformToString(), 'version two');
  assert.equal((await fetch(`http://127.0.0.1:39500/${bucket}/attachment.txt`)).status, 403);
  if (process.argv[2] === 'verify') {
    writeFileSync(process.env.STORAGE_UPGRADE_EVIDENCE, JSON.stringify({ status: 'PASS',
      modeledLegacyRelease: 'RELEASE.2025-09-07T16-13-09Z', sourceSnapshot: '7aac2a2c5b7c882e68c1ce017d8256be2feea27f',
      versionsPreserved: 4, checksumsAndMetadataPreserved: true, latestVersionPreserved: true,
      anonymousReadDenied: true, actualProductionVolume: false }, null, 2));
    console.log('Modeled legacy storage upgrade: 4 versions, checksums, metadata and private access PASS');
  }
})().catch(e => { console.error(e.message); process.exit(1); }).finally(() => client.destroy());
