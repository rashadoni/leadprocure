const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createManifest, verifyManifest, validateEndpoint, validateSource } = require('./manifest.cjs');
const source = 'a'.repeat(40);
const endpoint = 'http://75.119.156.234:3100';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lp-release-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = {};
  for (const [index, service] of ['api', 'web'].entries()) {
    files[service] = path.join(dir, `${service}.json`);
    await writeFile(files[service], JSON.stringify([{
      Id: `sha256:${String(index + 1).repeat(64)}`,
      RepoTags: [`leadprocure-${service}:${source}`], Os: 'linux', Architecture: 'amd64',
      Config: { Env: ['SECRET=must-not-be-published'], Labels: { 'org.opencontainers.image.revision': source } },
    }]));
  }
  await writeFile(path.join(dir, 'leadprocure-images.tar.gz'), 'archive fixture');
  await createManifest(dir, source, endpoint, files);
  return { dir, files };
}
test('valid package verifies without leaking image environment', async (t) => {
  const { dir } = await fixture(t);
  await verifyManifest(dir, source, endpoint);
  assert(!(await readFile(path.join(dir, 'manifest.json'), 'utf8')).includes('SECRET'));
});
test('same-size archive corruption is rejected by checksum', async (t) => {
  const { dir } = await fixture(t);
  await writeFile(path.join(dir, 'leadprocure-images.tar.gz'), 'Archive fixture');
  await assert.rejects(verifyManifest(dir, source, endpoint), /checksum/);
});
test('wrong source and browser route are rejected', async (t) => {
  const { dir } = await fixture(t);
  await assert.rejects(verifyManifest(dir, 'b'.repeat(40), endpoint), /source commit/);
  await assert.rejects(verifyManifest(dir, source, 'https://other.example.com'), /API URL/);
});
test('archive traversal and demo mode are rejected', async (t) => {
  const { dir } = await fixture(t);
  const file = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.archive.file = '../outside.tar.gz';
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(verifyManifest(dir, source, endpoint), /archive path/);
  manifest.archive.file = 'leadprocure-images.tar.gz';
  manifest.demoHint = true;
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(verifyManifest(dir, source, endpoint));
});
test('foreign revision and wrong architecture cannot create a release', async (t) => {
  const { dir, files } = await fixture(t);
  const metadata = JSON.parse(await readFile(files.api, 'utf8'));
  metadata[0].Config.Labels['org.opencontainers.image.revision'] = 'b'.repeat(40);
  await writeFile(files.api, JSON.stringify(metadata));
  await assert.rejects(createManifest(dir, source, endpoint, files), /revision/);
  metadata[0].Config.Labels['org.opencontainers.image.revision'] = source;
  metadata[0].Architecture = 'arm64';
  await writeFile(files.api, JSON.stringify(metadata));
  await assert.rejects(createManifest(dir, source, endpoint, files), /amd64/);
});
test('unsafe URLs and abbreviated refs are rejected', () => {
  for (const url of ['file:///tmp/x', 'http://user:secret@example.com', 'https://example.com?token=x', 'https://example.com#x', 'http://localhost:3100', 'http://127.0.0.1:3100']) {
    assert.throws(() => validateEndpoint(url));
  }
  assert.throws(() => validateSource('main'));
  assert.throws(() => validateSource('11c351b'));
});
